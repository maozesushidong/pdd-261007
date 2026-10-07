import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  advanceReturnRefundWaitBudget,
  classifyReturnRefundWaitState,
  createReturnRefundWaitTimeoutError,
  returnRefundProgressMarker,
} from '../apps/worker/src/return-refund-wait-state.mjs';
import {
  isReturnRefundScanDue,
  nextReturnRefundScanRetry,
  returnRefundScanStartupDelay,
  shouldPrioritizeReturnRefundScan,
} from '../apps/worker/src/return-refund-scan-policy.mjs';
import { stringifyJsonb } from '../packages/adapters/src/postgres/index.mjs';
import { canonicalDetectedPddShopName } from '../apps/worker/src/pdd-shop-identity.mjs';
import {
  advanceBrowserProxyNavigationFailureCircuit,
  browserScaleIsExpected,
  detectBrowserProxyNavigationFailure,
  inspectBrowserScale,
  probeBrowserProxyConnectivity,
  resolveBrowserProxyConfig,
} from '../packages/adapters/src/browser-runtime-config.mjs';
import { decideBrowserProbeFailure } from '../packages/adapters/src/browser-runtime-state.mjs';
import { expandOrdinaryPddOptionAliases } from '../packages/adapters/src/pdd/ordinary-work-orders.mjs';
import { classifyReturnRefundUnexpectedFailure } from '../packages/adapters/src/pdd/return-refund.mjs';
import { isTransientTmsOmsQueryMessage } from '../packages/adapters/src/tms/query-state.mjs';
import {
  workflowAuthenticationState,
  workflowHeartbeatState,
  workflowStallExemption,
} from '../apps/worker/src/workflow-stall-policy.mjs';
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
  shouldReusePreClaimVerificationRecovery,
} from '../apps/worker/src/verification-recovery-policy.mjs';
import { retryPostgresCheckpoint } from '../apps/worker/src/postgres-checkpoint-retry.mjs';
import {
  inspectBrowserProxyConfiguration,
  inspectWorkerBrowserProxy,
  parseBrowserProxyEnvironment,
} from './browser-proxy-preflight.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

{
  const request = Object.freeze({ leaseToken: 'lease-1', payload: Object.freeze({ step: 'pdd-detail' }) });
  const calls = [];
  const waits = [];
  const retries = [];
  const result = await retryPostgresCheckpoint(async () => {
    calls.push(request);
    if (calls.length <= 2) {
      const error = new Error(calls.length === 1 ? 'deadlock' : 'serialization failure');
      error.code = calls.length === 1 ? '40P01' : '40001';
      throw error;
    }
    return true;
  }, {
    wait: async (delayMs) => waits.push(delayMs),
    onRetry: (retry) => retries.push(retry),
  });
  assert.equal(result, true);
  assert.equal(calls.length, 3, 'a checkpoint may make at most two short database retries');
  assert.ok(calls.every((value) => value === request),
    'every checkpoint retry must reuse the exact same fenced request');
  assert.deepEqual(waits, [25, 75]);
  assert.deepEqual(retries.map(({ attempt, maxAttempts, code }) => ({ attempt, maxAttempts, code })), [
    { attempt: 2, maxAttempts: 3, code: '40P01' },
    { attempt: 3, maxAttempts: 3, code: '40001' },
  ]);

  let nonRetryableCalls = 0;
  const nonRetryable = new Error('connection lost');
  nonRetryable.code = '08006';
  await assert.rejects(() => retryPostgresCheckpoint(async () => {
    nonRetryableCalls += 1;
    throw nonRetryable;
  }, { wait: async () => assert.fail('a non-retryable database error must not wait') }), nonRetryable);
  assert.equal(nonRetryableCalls, 1);

  let exhaustedCalls = 0;
  const exhausted = new Error('persistent deadlock');
  exhausted.code = '40P01';
  await assert.rejects(() => retryPostgresCheckpoint(async () => {
    exhaustedCalls += 1;
    throw exhausted;
  }, { wait: async () => {} }), exhausted);
  assert.equal(exhaustedCalls, 3, 'retryable checkpoint failures must still stop after three attempts');
}

assert.equal(isReturnRefundScanDue({
  cursor: { page: 2, itemOffset: 0 },
  now: 20_000,
  retryNotBefore: 30_000,
}), false, 'a failed partial scan must honor its bounded retry delay');
assert.equal(isReturnRefundScanDue({
  cursor: { page: 2, itemOffset: 0 },
  now: 30_000,
  retryNotBefore: 30_000,
}), true, 'a partial scan must resume as soon as its retry delay expires');
assert.equal(isReturnRefundScanDue({
  now: 1_800_000,
  lastSuccessfulScanAt: 0,
  intervalMs: 1_800_000,
}), true, 'a completed scan must become due at the configured interval');
assert.equal(shouldPrioritizeReturnRefundScan({
  configured: true,
  scanDue: true,
  directClaimsSinceScan: 2,
  directClaimsBeforeScan: 10,
  lastSuccessfulScanAt: 1_000,
  forceIntervalMs: 10_000,
  now: 10_999,
}), false, 'fresh scans may still yield to the configured direct-refund batch');
assert.equal(shouldPrioritizeReturnRefundScan({
  configured: true,
  scanDue: true,
  directClaimsSinceScan: 10,
  directClaimsBeforeScan: 10,
  lastSuccessfulScanAt: 9_000,
  forceIntervalMs: 10_000,
  now: 10_000,
}), true, 'the configured direct-refund batch must yield to a due scan');
assert.equal(shouldPrioritizeReturnRefundScan({
  configured: true,
  scanDue: true,
  directClaimsSinceScan: 1,
  directClaimsBeforeScan: 10,
  lastSuccessfulScanAt: 1_000,
  forceIntervalMs: 10_000,
  now: 11_000,
}), true, 'a stale full scan must not starve behind existing refund claims');
assert.equal(returnRefundScanStartupDelay({ shopKey: '', maxDelayMs: 600_000 }), 0,
  'an unbound shop must not invent a startup scan delay');
assert.equal(returnRefundScanStartupDelay({ shopKey: 'shop-a', maxDelayMs: 0 }), 0,
  'operators must be able to disable startup scan staggering');
assert.equal(
  returnRefundScanStartupDelay({ shopKey: 'shop-a', maxDelayMs: 600_000 }),
  returnRefundScanStartupDelay({ shopKey: 'shop-a', maxDelayMs: 600_000 }),
  'startup scan staggering must be stable for the same shop',
);
assert.notEqual(
  returnRefundScanStartupDelay({ shopKey: 'shop-a', maxDelayMs: 600_000 }),
  returnRefundScanStartupDelay({ shopKey: 'shop-b', maxDelayMs: 600_000 }),
  'different shops should not restart their full scans at the same instant',
);
assert.deepEqual(
  [0, 1, 2, 3].map((slotIndex) => returnRefundScanStartupDelay({
    shopKey: `shop-${slotIndex}`,
    maxDelayMs: 400_000,
    slotIndex,
    slotCount: 4,
  })),
  [50_000, 150_000, 250_000, 350_000],
  'known display slots must spread shared-restart scans evenly across the window',
);
assert.deepEqual(nextReturnRefundScanRetry({
  error: { code: 'RETURN_REFUND_VERIFICATION_REQUIRED' },
  now: 100_000,
}), {
  verificationRequired: true,
  loginRequired: false,
  retryDelayMs: 10_000,
  retryNotBefore: 110_000,
});
assert.deepEqual(nextReturnRefundScanRetry({
  error: { result: { status: 'login-required' } },
  now: 100_000,
}), {
  verificationRequired: false,
  loginRequired: true,
  retryDelayMs: 10_000,
  retryNotBefore: 110_000,
}, 'a PDD login interruption must use the short authentication retry without becoming verification');
assert.equal(nextReturnRefundScanRetry({
  error: new Error('page render failed'),
  now: 100_000,
}).retryNotBefore, 220_000, 'ordinary scan failures must use the bounded two-minute backoff');

const verificationReason = '检测到人工验证，请在可视化浏览器中完成后重新运行流程（阶段: detail，URL: https://example.test）';
assert.equal(isHumanVerificationInterruptionReason(verificationReason), true);
assert.deepEqual(
  classifyInterruptedVerification({
    progress: {
      step: 'flow-paused',
      verificationLocation: { id: 'active', status: 'waiting-human', detectedAt: '2026-08-23T05:00:00Z' },
    },
    reason: 'unrelated error',
  }),
  {
    state: 'waiting',
    source: 'progress',
    verificationId: 'active',
    stage: null,
    status: 'waiting-human',
    detectedAt: '2026-08-23T05:00:00Z',
    resolvedAt: null,
  },
);
assert.equal(classifyInterruptedVerification({
  progress: { step: 'flow-paused', updatedAt: '2026-08-23T05:01:00Z' },
  reason: verificationReason,
  persistedVerification: {
    id: 'resolved',
    stage: 'detail',
    status: 'resolved',
    detected_at: '2026-08-23T05:00:02Z',
    resolved_at: '2026-08-23T05:00:40Z',
  },
  claimHydratedAtMs: Date.parse('2026-08-23T05:00:00Z'),
})?.state, 'resolved');
assert.equal(classifyInterruptedVerification({
  progress: {
    step: 'flow-paused',
    verificationLocation: {
      id: 'plugin-resolved',
      status: 'resolved',
      detectedAt: '2026-08-23T05:00:02Z',
      resolvedAt: '2026-08-23T05:00:40Z',
    },
  },
  reason: verificationReason,
})?.source, 'progress');
assert.equal(classifyInterruptedVerification({
  progress: { step: 'flow-paused', updatedAt: '2026-08-23T05:01:00Z' },
  reason: verificationReason,
  persistedVerification: {
    id: 'stale-resolved',
    status: 'resolved',
    detected_at: '2026-08-23T04:00:00Z',
    resolved_at: '2026-08-23T04:00:40Z',
  },
  claimHydratedAtMs: Date.parse('2026-08-23T05:00:00Z'),
})?.source, 'workflow-error');
assert.equal(classifyInterruptedVerification({
  progress: { step: 'flow-paused', updatedAt: '2026-08-23T05:01:00Z' },
  reason: verificationReason,
  persistedVerification: {
    id: 'checkpoint-resolved',
    status: 'resolved',
    detected_at: '2026-08-23T05:00:40Z',
    resolved_at: '2026-08-23T05:01:00Z',
  },
  claimHydratedAtMs: Date.parse('2026-08-23T05:00:00Z'),
})?.source, 'workflow-error');
assert.deepEqual(classifyInterruptedVerification({
  progress: {
    step: 'flow-paused',
    updatedAt: '2026-08-23T05:01:10Z',
    verificationLocation: null,
    verificationRecheck: {
      trigger: 'resident-browser-live-pages',
      status: 'cleared',
      verificationId: 'resident-cleared',
      detectedAt: '2026-08-23T05:00:02Z',
      completedAt: '2026-08-23T05:01:05Z',
    },
  },
  reason: '工作流已进入人工复核暂停状态',
  claimHydratedAtMs: Date.parse('2026-08-23T05:00:00Z'),
}), {
  state: 'resolved',
  source: 'progress-recheck',
  verificationId: 'resident-cleared',
  stage: null,
  status: 'resolved',
  detectedAt: '2026-08-23T05:00:02Z',
  resolvedAt: '2026-08-23T05:01:05Z',
});
assert.equal(classifyInterruptedVerification({
  progress: {
    step: 'flow-paused',
    verificationRecheck: {
      trigger: 'resident-browser-live-pages',
      status: 'cleared',
      completedAt: '2026-08-23T04:00:00Z',
    },
  },
  reason: 'ordinary locator timeout',
  claimHydratedAtMs: Date.parse('2026-08-23T05:00:00Z'),
}), null, 'a stale cleared-verification observation must not reclassify an unrelated failure');
assert.equal(classifyInterruptedVerification({
  progress: { step: 'flow-paused' },
  reason: 'ordinary locator timeout',
}) , null);
assert.deepEqual(classifyClearedResidentVerification({
  progress: {
    step: 'pdd-session-recovered',
    residentCommand: {
      assignmentId: 'lease-current',
      status: 'idle',
      outcome: 'verification-required',
      completedAt: '2026-08-27T04:00:24Z',
    },
    verificationLocation: null,
    verificationRecheck: {
      trigger: 'resident-browser-live-pages',
      status: 'cleared',
      verificationId: 'verification-current',
      detectedAt: '2026-08-27T03:58:21Z',
      completedAt: '2026-08-27T04:02:15Z',
    },
  },
  leaseToken: 'lease-current',
  claimHydratedAtMs: Date.parse('2026-08-27T03:57:48Z'),
}), {
  state: 'resolved',
  source: 'resident-browser-live-pages',
  verificationId: 'verification-current',
  stage: null,
  status: 'resolved',
  detectedAt: '2026-08-27T03:58:21Z',
  resolvedAt: '2026-08-27T04:02:15Z',
});
assert.equal(classifyClearedResidentVerification({
  progress: {
    residentCommand: {
      assignmentId: 'lease-current',
      status: 'idle',
      outcome: 'verification-required',
      completedAt: '2026-08-27T04:03:00Z',
    },
    verificationRecheck: {
      status: 'cleared',
      completedAt: '2026-08-27T04:02:15Z',
    },
  },
  leaseToken: 'lease-current',
  claimHydratedAtMs: Date.parse('2026-08-27T03:57:48Z'),
}), null, 'an old cleared observation must not release a newer verification command');
assert.deepEqual(classifyClearedResidentVerification({
  progress: {
    step: 'pdd-session-recovered',
    residentCommand: {
      assignmentId: 'lease-current',
      status: 'idle',
      outcome: 'verification-required',
      completedAt: '2026-08-27T04:03:00Z',
    },
    authHealth: {
      pdd: { status: 'authenticated', checkedAt: '2026-08-27T04:03:15Z' },
    },
    runtimeObservation: { observedAt: '2026-08-27T04:03:15Z' },
    verificationLocation: null,
    verificationRecheck: {
      trigger: 'resident-browser-live-pages',
      status: 'cleared',
      verificationId: 'verification-current',
      detectedAt: '2026-08-27T03:58:21Z',
      completedAt: '2026-08-27T04:02:15Z',
    },
  },
  leaseToken: 'lease-current',
  claimHydratedAtMs: Date.parse('2026-08-27T03:57:48Z'),
}), {
  state: 'resolved',
  source: 'resident-browser-post-command-authenticated',
  verificationId: 'verification-current',
  stage: null,
  status: 'resolved',
  detectedAt: '2026-08-27T03:58:21Z',
  resolvedAt: '2026-08-27T04:03:15Z',
}, 'a post-command authenticated browser observation must release a cleared verification claim');
assert.equal(classifyClearedResidentVerification({
  progress: {
    residentCommand: {
      assignmentId: 'lease-old',
      status: 'idle',
      outcome: 'verification-required',
      completedAt: '2026-08-27T04:00:24Z',
    },
    verificationRecheck: {
      status: 'cleared',
      completedAt: '2026-08-27T04:02:15Z',
    },
  },
  leaseToken: 'lease-current',
  claimHydratedAtMs: Date.parse('2026-08-27T03:57:48Z'),
}), null, 'a cleared observation from another lease must not release the current claim');
assert.deepEqual(classifyWaitingResidentVerification({
  progress: {
    step: 'human-verification-required',
    residentCommand: {
      assignmentId: 'lease-current',
      status: 'idle',
      outcome: 'verification-required',
      completedAt: '2026-08-27T04:03:00Z',
    },
    authHealth: { pdd: { status: 'verification-required' } },
    verificationLocation: {
      id: 'verification-waiting',
      stage: 'open-pinduoduo-target',
      status: 'waiting-human',
      detectedAt: '2026-08-27T04:00:20Z',
    },
  },
  leaseToken: 'lease-current',
  claimHydratedAtMs: Date.parse('2026-08-27T04:00:00Z'),
}), {
  state: 'waiting',
  source: 'progress',
  verificationId: 'verification-waiting',
  stage: 'open-pinduoduo-target',
  status: 'waiting-human',
  detectedAt: '2026-08-27T04:00:20Z',
  resolvedAt: null,
}, 'a settled resident verification command must release its ordinary claim while preserving the challenge');
assert.equal(classifyWaitingResidentVerification({
  progress: {
    step: 'human-verification-required',
    residentCommand: {
      assignmentId: 'lease-old',
      status: 'idle',
      outcome: 'verification-required',
      completedAt: '2026-08-27T04:03:00Z',
    },
    authHealth: { pdd: { status: 'verification-required' } },
  },
  leaseToken: 'lease-current',
  claimHydratedAtMs: Date.parse('2026-08-27T04:00:00Z'),
}), null, 'a waiting verification from another lease must not release the current claim');
assert.deepEqual(classifyResidentLoginInterruption({
  progress: {
    step: 'manual-login-required',
    residentCommand: {
      assignmentId: 'lease-current',
      status: 'idle',
      outcome: 'login-required',
      completedAt: '2026-08-27T04:03:00Z',
    },
    authHealth: { pdd: { status: 'expired' } },
    systemLogin: {
      system: 'pdd',
      status: 'required',
      stage: 'pinduoduo-login',
      detectedAt: '2026-08-27T04:02:50Z',
    },
  },
  leaseToken: 'lease-current',
  claimHydratedAtMs: Date.parse('2026-08-27T04:00:00Z'),
}), {
  state: 'waiting',
  source: 'resident-command',
  system: 'pdd',
  stage: 'pinduoduo-login',
  detectedAt: '2026-08-27T04:02:50Z',
  resolvedAt: null,
}, 'a current PDD login interruption must release the claim without creating verification state');
assert.deepEqual(classifyResidentLoginInterruption({
  progress: {
    step: 'pdd-session-recovered',
    residentCommand: {
      assignmentId: 'lease-current',
      status: 'idle',
      outcome: 'login-required',
      completedAt: '2026-08-27T04:03:00Z',
    },
    authHealth: {
      pdd: { status: 'authenticated', checkedAt: '2026-08-27T04:04:00Z' },
    },
    systemLogin: { system: 'pdd', status: 'required', stage: 'pinduoduo-login' },
    runtimeObservation: {
      observedAt: '2026-08-27T04:04:00Z',
      source: 'resident-browser-live-pages',
    },
  },
  leaseToken: 'lease-current',
  claimHydratedAtMs: Date.parse('2026-08-27T04:00:00Z'),
}), {
  state: 'resolved',
  source: 'resident-browser-live-pages',
  system: 'pdd',
  stage: 'pinduoduo-login',
  detectedAt: null,
  resolvedAt: '2026-08-27T04:04:00Z',
}, 'a fresh authenticated browser observation must resume the login-interrupted claim');
assert.equal(classifyResidentLoginInterruption({
  progress: {
    step: 'manual-login-required',
    residentCommand: {
      assignmentId: 'lease-old',
      status: 'idle',
      outcome: 'login-required',
      completedAt: '2026-08-27T04:03:00Z',
    },
    authHealth: { pdd: { status: 'expired' } },
    systemLogin: { system: 'pdd', status: 'required' },
  },
  leaseToken: 'lease-current',
  claimHydratedAtMs: Date.parse('2026-08-27T04:00:00Z'),
}), null, 'a login interruption from another lease must not release the current claim');
assert.deepEqual(classifyDetachedClearedReturnRefundVerification({
  progress: {
    step: 'pdd-session-recovered',
    residentCommand: {
      action: 'run-refund',
      assignmentId: 'detached-refund-assignment',
      status: 'idle',
      outcome: 'verification-required',
      completedAt: '2026-08-27T04:00:24Z',
    },
    verificationLocation: null,
    verificationRecheck: {
      trigger: 'resident-browser-live-pages',
      status: 'cleared',
      verificationId: 'detached-refund-verification',
      detectedAt: '2026-08-27T03:58:21Z',
      completedAt: '2026-08-27T04:02:15Z',
    },
  },
}), {
  assignmentId: 'detached-refund-assignment',
  verificationId: 'detached-refund-verification',
  commandCompletedAt: '2026-08-27T04:00:24Z',
  detectedAt: '2026-08-27T03:58:21Z',
  resolvedAt: '2026-08-27T04:02:15Z',
});
assert.deepEqual(classifyDetachedClearedReturnRefundVerification({
  progress: {
    step: 'resident-discovery-starting',
    residentCommand: {
      action: 'run-refund',
      assignmentId: 'detached-refund-precompleted-clear',
      status: 'idle',
      outcome: 'verification-required',
      completedAt: '2026-08-27T04:03:00Z',
    },
    authHealth: {
      pdd: {
        status: 'authenticated',
        checkedAt: '2026-08-27T04:04:00Z',
      },
    },
    runtimeObservation: {
      observedAt: '2026-08-27T04:04:00Z',
    },
    verificationLocation: null,
    verificationRecheck: {
      trigger: 'resident-browser-live-pages',
      status: 'cleared',
      verificationId: 'detached-refund-precompleted-verification',
      detectedAt: '2026-08-27T04:00:00Z',
      completedAt: '2026-08-27T04:02:00Z',
    },
  },
}), {
  assignmentId: 'detached-refund-precompleted-clear',
  verificationId: 'detached-refund-precompleted-verification',
  commandCompletedAt: '2026-08-27T04:03:00Z',
  detectedAt: '2026-08-27T04:00:00Z',
  resolvedAt: '2026-08-27T04:04:00Z',
}, 'a post-command authenticated observation must recover a refund cleared before command completion');
assert.deepEqual(classifyDetachedClearedReturnRefundVerification({
  progress: {
    step: 'resident-discovery-starting',
    residentCommand: {
      action: 'discover',
      assignmentId: null,
      status: 'active',
    },
    lastVerificationResidentCommand: {
      action: 'run-refund',
      assignmentId: 'detached-refund-settled-command',
      status: 'idle',
      outcome: 'verification-required',
      completedAt: '2026-08-27T04:03:00Z',
    },
    authHealth: {
      pdd: {
        status: 'authenticated',
        checkedAt: '2026-08-27T04:04:00Z',
      },
    },
    runtimeObservation: {
      observedAt: '2026-08-27T04:04:00Z',
    },
    verificationLocation: null,
    verificationRecheck: {
      trigger: 'resident-browser-live-pages',
      status: 'cleared',
      verificationId: 'detached-refund-settled-verification',
      detectedAt: '2026-08-27T04:00:00Z',
      completedAt: '2026-08-27T04:02:00Z',
    },
  },
}), {
  assignmentId: 'detached-refund-settled-command',
  verificationId: 'detached-refund-settled-verification',
  commandCompletedAt: '2026-08-27T04:03:00Z',
  detectedAt: '2026-08-27T04:00:00Z',
  resolvedAt: '2026-08-27T04:04:00Z',
}, 'a later resident command must not erase the settled refund verification identity');
assert.equal(classifyDetachedClearedReturnRefundVerification({
  progress: {
    residentCommand: {
      action: 'run-order',
      assignmentId: 'ordinary-assignment',
      status: 'idle',
      outcome: 'verification-required',
      completedAt: '2026-08-27T04:00:24Z',
    },
    verificationRecheck: {
      trigger: 'resident-browser-live-pages',
      status: 'cleared',
      verificationId: 'ordinary-verification',
      completedAt: '2026-08-27T04:02:15Z',
    },
  },
}), null, 'the detached recovery channel must not alter ordinary work-order scheduling');
const staleGateVerification = {
  id: '7efa3edc-c15a-4a08-8939-af1e303412b6',
  work_order_id: null,
  system_name: 'pdd',
  stage: 'return-refund-close-detail-before',
  status: 'waiting-human',
  detected_at: '2026-08-29T01:02:29.841Z',
  resolved_at: null,
};
const staleGateProgress = {
  verificationLocation: null,
  authHealth: {
    pdd: {
      status: 'authenticated',
      checkedAt: '2026-08-29T05:03:44.055Z',
    },
  },
  runtimeObservation: {
    source: 'resident-browser-live-pages',
    observedAt: '2026-08-29T05:34:16.797Z',
    urls: { pdd: 'https://mms.pinduoduo.com/aftersales/work_order/list' },
  },
};
assert.deepEqual(classifyStalePreClaimVerificationGate({
  persistedVerification: staleGateVerification,
  progress: staleGateProgress,
  nowMs: Date.parse('2026-08-29T05:34:20.000Z'),
}), {
  verificationId: staleGateVerification.id,
  detectedAt: '2026-08-29T01:02:29.841Z',
  authenticatedAt: '2026-08-29T05:03:44.055Z',
  runtimeObservedAt: '2026-08-29T05:34:16.797Z',
  resolvedAt: '2026-08-29T05:34:20.000Z',
  source: 'fresh-authenticated-resident-browser-without-challenge',
}, 'a fresh authenticated resident browser may clear an old detached PDD gate');
assert.equal(classifyStalePreClaimVerificationGate({
  persistedVerification: { ...staleGateVerification, work_order_id: 'bound-work-order' },
  progress: staleGateProgress,
  nowMs: Date.parse('2026-08-29T05:34:20.000Z'),
}), null, 'a work-order-bound verification must never be cleared by the detached gate');
assert.equal(classifyStalePreClaimVerificationGate({
  persistedVerification: staleGateVerification,
  progress: {
    ...staleGateProgress,
    verificationLocation: { id: staleGateVerification.id, status: 'waiting-human' },
  },
  nowMs: Date.parse('2026-08-29T05:34:20.000Z'),
}), null, 'a challenge still visible in current progress must remain blocked');
assert.equal(classifyStalePreClaimVerificationGate({
  persistedVerification: staleGateVerification,
  progress: {
    ...staleGateProgress,
    authHealth: { pdd: { status: 'verification-required', checkedAt: '2026-08-29T05:03:44.055Z' } },
  },
  nowMs: Date.parse('2026-08-29T05:34:20.000Z'),
}), null, 'verification-required authentication evidence must preserve the gate');
assert.equal(classifyStalePreClaimVerificationGate({
  persistedVerification: staleGateVerification,
  progress: {
    ...staleGateProgress,
    authHealth: { pdd: { status: 'authenticated', checkedAt: '2026-08-29T01:00:00.000Z' } },
  },
  nowMs: Date.parse('2026-08-29T05:34:20.000Z'),
}), null, 'authentication evidence from before detection is not proof of clearance');
assert.equal(classifyStalePreClaimVerificationGate({
  persistedVerification: staleGateVerification,
  progress: staleGateProgress,
  nowMs: Date.parse('2026-08-29T05:40:00.000Z'),
}), null, 'a stale runtime observation must not clear a persisted gate');
const staleBoundGateVerification = {
  ...staleGateVerification,
  work_order_id: '82431134-c240-4ef1-8b97-1c51203e3bb6',
};
assert.deepEqual(classifyStaleBoundPreClaimVerificationGate({
  persistedVerification: staleBoundGateVerification,
  progress: staleGateProgress,
  nowMs: Date.parse('2026-08-29T05:34:20.000Z'),
}), {
  verificationId: staleBoundGateVerification.id,
  workOrderId: staleBoundGateVerification.work_order_id,
  detectedAt: '2026-08-29T01:02:29.841Z',
  authenticatedAt: '2026-08-29T05:03:44.055Z',
  runtimeObservedAt: '2026-08-29T05:34:16.797Z',
  resolvedAt: '2026-08-29T05:34:20.000Z',
  observedUrl: 'https://mms.pinduoduo.com/aftersales/work_order/list',
  source: 'fresh-authenticated-resident-browser-without-detached-bound-challenge',
}, 'a fresh resident list page may release an old bound gate for read-only reevaluation');
const staleBoundDateObjectGate = classifyStaleBoundPreClaimVerificationGate({
  persistedVerification: {
    ...staleBoundGateVerification,
    detected_at: new Date(staleBoundGateVerification.detected_at),
  },
  progress: staleGateProgress,
  nowMs: Date.parse('2026-08-29T05:34:20.000Z'),
});
assert.equal(staleBoundDateObjectGate?.detectedAt, '2026-08-29T01:02:29.841Z',
  'PostgreSQL Date values must preserve milliseconds for the exact verification update');
assert.equal(classifyStaleBoundPreClaimVerificationGate({
  persistedVerification: staleGateVerification,
  progress: staleGateProgress,
  nowMs: Date.parse('2026-08-29T05:34:20.000Z'),
}), null, 'the bound recovery channel must not alter a shop-level verification');
assert.equal(classifyStaleBoundPreClaimVerificationGate({
  persistedVerification: staleBoundGateVerification,
  progress: {
    ...staleGateProgress,
    verificationLocation: { id: staleBoundGateVerification.id, status: 'waiting-human' },
  },
  nowMs: Date.parse('2026-08-29T05:34:20.000Z'),
}), null, 'a bound verification referenced by the current browser must stay blocked');
assert.equal(classifyStaleBoundPreClaimVerificationGate({
  persistedVerification: staleBoundGateVerification,
  progress: {
    ...staleGateProgress,
    runtimeObservation: {
      ...staleGateProgress.runtimeObservation,
      urls: { pdd: 'https://mms.pinduoduo.com/login/' },
    },
  },
  nowMs: Date.parse('2026-08-29T05:34:20.000Z'),
}), null, 'a login page must not release a bound verification');
assert.equal(classifyStaleBoundPreClaimVerificationGate({
  persistedVerification: staleBoundGateVerification,
  progress: staleGateProgress,
  nowMs: Date.parse('2026-08-29T05:40:00.000Z'),
}), null, 'stale browser evidence must not release a bound verification');
const restoredPreClaimVerification = {
  id: '3d7e0bd2-a885-4e9a-91ec-df016150bf1b',
  work_order_id: '59c91e84-da3a-476a-93b8-d14bfcc31f8b',
  system_name: 'pdd',
  stage: 'open-shipping-logistics-action-error',
  status: 'waiting-human',
  url: 'https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=123456',
  detected_at: '2026-08-30T04:00:00.000Z',
  resolved_at: null,
};
const restoredPreClaimProgress = {
  verificationLocation: null,
  authHealth: {
    pdd: {
      status: 'authenticated',
      checkedAt: '2026-08-30T04:11:00.000Z',
      url: restoredPreClaimVerification.url,
    },
  },
  verificationRecovery: {
    trigger: 'resident-browser-restart-recovery',
    status: 'cleared',
    verificationId: restoredPreClaimVerification.id,
    workOrderId: restoredPreClaimVerification.work_order_id,
    verificationUrl: restoredPreClaimVerification.url,
    observedUrl: restoredPreClaimVerification.url,
    startedAt: '2026-08-30T04:10:00.000Z',
    authenticatedAt: '2026-08-30T04:11:00.000Z',
    completedAt: '2026-08-30T04:12:00.000Z',
    externalActionsReplayed: false,
  },
  verificationRecheck: {
    trigger: 'resident-browser-restart-recovery',
    status: 'cleared',
    verificationId: restoredPreClaimVerification.id,
    workOrderId: restoredPreClaimVerification.work_order_id,
    completedAt: '2026-08-30T04:12:00.000Z',
    externalActionsReplayed: false,
  },
};
assert.deepEqual(classifyRestoredPreClaimVerification({
  persistedVerification: restoredPreClaimVerification,
  progress: restoredPreClaimProgress,
  nowMs: Date.parse('2026-08-30T04:12:30.000Z'),
}), {
  verificationId: restoredPreClaimVerification.id,
  workOrderId: restoredPreClaimVerification.work_order_id,
  detectedAt: restoredPreClaimVerification.detected_at,
  recoveryStartedAt: '2026-08-30T04:10:00.000Z',
  authenticatedAt: '2026-08-30T04:11:00.000Z',
  resolvedAt: '2026-08-30T04:12:00.000Z',
  verificationUrl: restoredPreClaimVerification.url,
  observedUrl: restoredPreClaimVerification.url,
  source: 'resident-browser-restart-recovery',
}, 'an exact fresh authenticated restart recovery may clear its persisted PDD gate');
assert.equal(classifyRestoredPreClaimVerification({
  persistedVerification: restoredPreClaimVerification,
  progress: {
    ...restoredPreClaimProgress,
    verificationRecovery: {
      ...restoredPreClaimProgress.verificationRecovery,
      workOrderId: 'deec873b-038d-47ec-b4fa-55c947c15bd2',
    },
  },
  nowMs: Date.parse('2026-08-30T04:12:30.000Z'),
}), null, 'restart recovery evidence for another work order must remain fenced');
assert.equal(classifyRestoredPreClaimVerification({
  persistedVerification: restoredPreClaimVerification,
  progress: {
    ...restoredPreClaimProgress,
    verificationLocation: { id: restoredPreClaimVerification.id, status: 'waiting-human' },
  },
  nowMs: Date.parse('2026-08-30T04:12:30.000Z'),
}), null, 'a challenge that is still visible must remain blocked');
assert.equal(classifyRestoredPreClaimVerification({
  persistedVerification: restoredPreClaimVerification,
  progress: restoredPreClaimProgress,
  nowMs: Date.parse('2026-08-30T04:20:00.000Z'),
}), null, 'stale restart recovery evidence must not clear a persisted gate');
assert.equal(classifyRestoredPreClaimVerification({
  persistedVerification: restoredPreClaimVerification,
  progress: {
    ...restoredPreClaimProgress,
    authHealth: { pdd: { status: 'authenticated', checkedAt: '2026-08-30T04:11:00.000Z' } },
    verificationRecovery: {
      ...restoredPreClaimProgress.verificationRecovery,
      observedUrl: 'https://mms.pinduoduo.com/login/',
    },
  },
  nowMs: Date.parse('2026-08-30T04:12:30.000Z'),
}), null, 'a PDD login page is not authenticated recovery evidence');
const reusableRecoveryCommand = {
  action: 'restore-verification',
  status: 'idle',
  requestId: 'restore-request-1',
  verificationId: restoredPreClaimVerification.id,
  workOrderId: restoredPreClaimVerification.work_order_id,
};
const reusableRecovery = {
  ...restoredPreClaimProgress.verificationRecovery,
  requestId: reusableRecoveryCommand.requestId,
  startedAt: '2026-08-30T04:10:00.000Z',
  authenticatedAt: '2026-08-30T04:11:00.000Z',
  completedAt: '2026-08-30T04:12:00.000Z',
};
assert.equal(shouldReusePreClaimVerificationRecovery({
  recovery: reusableRecovery,
  residentCommand: reusableRecoveryCommand,
  verificationId: restoredPreClaimVerification.id,
  workOrderId: restoredPreClaimVerification.work_order_id,
  nowMs: Date.parse('2026-08-30T04:12:30.000Z'),
}), true, 'fresh ordered recovery evidence may be reused while Postgres reconciles it');
assert.equal(shouldReusePreClaimVerificationRecovery({
  recovery: {
    ...reusableRecovery,
    startedAt: '2026-08-30T04:11:30.000Z',
  },
  residentCommand: reusableRecoveryCommand,
  verificationId: restoredPreClaimVerification.id,
  workOrderId: restoredPreClaimVerification.work_order_id,
  nowMs: Date.parse('2026-08-30T04:12:30.000Z'),
}), false, 'recovery must be retried when its reused login observation predates the attempt');
assert.equal(shouldReusePreClaimVerificationRecovery({
  recovery: reusableRecovery,
  residentCommand: reusableRecoveryCommand,
  verificationId: restoredPreClaimVerification.id,
  workOrderId: restoredPreClaimVerification.work_order_id,
  nowMs: Date.parse('2026-08-30T04:20:00.000Z'),
}), false, 'a stale cleared recovery must be retried instead of blocking the shop forever');
const waitingRecoveryCommand = {
  ...reusableRecoveryCommand,
  status: 'idle',
  outcome: 'verification-required',
  completedAt: '2026-08-30T04:12:00.000Z',
};
const waitingRecovery = {
  ...reusableRecovery,
  status: 'waiting-human',
  authenticatedAt: null,
  completedAt: null,
  observedUrl: restoredPreClaimVerification.url,
};
assert.equal(shouldReusePreClaimVerificationRecovery({
  recovery: waitingRecovery,
  residentCommand: waitingRecoveryCommand,
  progress: {
    step: 'human-verification-required',
    verificationLocation: {
      id: restoredPreClaimVerification.id,
      status: 'waiting-human',
    },
    authHealth: {
      pdd: { status: 'verification-required', url: restoredPreClaimVerification.url },
    },
    runtimeObservation: {
      urls: { pdd: restoredPreClaimVerification.url },
    },
  },
  verificationId: restoredPreClaimVerification.id,
  workOrderId: restoredPreClaimVerification.work_order_id,
}), true, 'the exact challenge page may keep waiting for human verification');
assert.equal(shouldReusePreClaimVerificationRecovery({
  recovery: waitingRecovery,
  residentCommand: waitingRecoveryCommand,
  progress: {
    step: 'human-verification-required',
    verificationLocation: {
      id: restoredPreClaimVerification.id,
      status: 'waiting-human',
    },
    authHealth: {
      pdd: { status: 'verification-required', url: restoredPreClaimVerification.url },
    },
    runtimeObservation: {
      urls: { pdd: 'https://mms.pinduoduo.com/aftersales/work_order/list' },
    },
  },
  verificationId: restoredPreClaimVerification.id,
  workOrderId: restoredPreClaimVerification.work_order_id,
}), false, 'a browser that left the challenge page must recheck instead of reusing a stale wait forever');
assert.equal(shouldReusePreClaimVerificationRecovery({
  recovery: {
    ...waitingRecovery,
    status: 'restoring',
    startedAt: '2026-08-30T04:00:00.000Z',
  },
  residentCommand: waitingRecoveryCommand,
  verificationId: restoredPreClaimVerification.id,
  workOrderId: restoredPreClaimVerification.work_order_id,
  nowMs: Date.parse('2026-08-30T04:20:00.000Z'),
}), false, 'an abandoned restoring marker must not block verification recovery forever');
const runner = await fsp.readFile(path.join(root, 'apps', 'worker', 'src', 'postgres-playwright-runner.mjs'), 'utf8');
const authenticationBrowserRecoverySource = runner.match(
  /function ensurePreClaimAuthenticationBrowser\(authentication\) \{([\s\S]*?)\n\}\n\nasync function ensurePreClaimVerificationBrowser/u,
);
assert.ok(authenticationBrowserRecoverySource,
  'manual PDD login must have a dedicated resident-browser recovery path');
assert.match(authenticationBrowserRecoverySource[1],
  /humanVerificationRequired[\s\S]*healthStatus === 'expired'[\s\S]*healthStatus === 'verification-required'/u,
  'stale PDD verification state without an active verification row must still restore a visible browser');
assert.match(authenticationBrowserRecoverySource[1],
  /activeExternalEffects\.size > 0[\s\S]*authenticationBrowserLaunchNotBefore[\s\S]*startLegacyPlaywright\(null, \{ discoverOnly: true \}\)/u,
  'authentication recovery must guard active effects, apply a cooldown, and launch discovery mode');
assert.doesNotMatch(authenticationBrowserRecoverySource[1], /waitForActiveResidentReady/u,
  'login and verification recovery must not wait for a ready signal those pages intentionally withhold');
assert.match(runner,
  /if \(authentication\.blocked\) \{[\s\S]{0,2500}ensurePreClaimAuthenticationBrowser\(authentication\);[\s\S]{0,200}observeOnboardingProgress/u,
  'the pre-claim authentication gate must restore a visible login browser before returning');
const dynamicSupervisor = await fsp.readFile(path.join(root, 'apps', 'worker', 'src', 'dynamic-supervisor.mjs'), 'utf8');
const slotSupervisor = await fsp.readFile(path.join(root, 'apps', 'worker', 'src', 'slot-supervisor.mjs'), 'utf8');
const browserHealthMonitor = await fsp.readFile(path.join(root, 'apps', 'worker', 'src', 'browser-health-monitor.mjs'), 'utf8');
const workerPreflight = await fsp.readFile(path.join(root, 'apps', 'worker', 'src', 'preflight.mjs'), 'utf8');
const nativeEnv = await fsp.readFile(path.join(root, '.env.native'), 'utf8');
const workflow = await fsp.readFile(path.join(root, 'workflow.mjs'), 'utf8');
assert.match(workflow,
  /current\.verificationRecovery\?\.requestId === command\.requestId/,
  'a new restore command must not inherit the previous attempt timestamp');
assert.match(workflow,
  /const authenticatedAt = new Date\(\)\.toISOString\(\);[\s\S]{0,700}source: 'resident-browser-restart-recovery'/,
  'verification recovery must record a fresh post-check authentication observation');
const workflowRuntime = await fsp.readFile(path.join(root, 'workflow-runtime.mjs'), 'utf8');
const pddOrderRemarkAdapter = await fsp.readFile(
  path.join(root, 'packages', 'adapters', 'src', 'pdd', 'order-remark.mjs'),
  'utf8',
);
const pddBackgroundPopup = await fsp.readFile(path.join(root, 'packages', 'adapters', 'src', 'pdd', 'background-popup.mjs'), 'utf8');
const returnRefund = await fsp.readFile(path.join(root, 'packages', 'adapters', 'src', 'pdd', 'return-refund.mjs'), 'utf8');
const apiDataBackend = await fsp.readFile(path.join(root, 'apps', 'api', 'src', 'data-backend.mjs'), 'utf8');
const incompleteWorkflowAnalysis = await fsp.readFile(
  path.join(root, 'apps', 'api', 'src', 'incomplete-workflow-analysis.mjs'),
  'utf8',
);
const webFormat = await fsp.readFile(path.join(root, 'apps', 'web', 'src', 'app', 'format.js'), 'utf8');
const scenarioConfig = JSON.parse(await fsp.readFile(path.join(root, 'config', 'scenarios.json'), 'utf8'));
const configuredScenarioCodes = scenarioConfig.scenarios
  .filter((scenario) => scenario.enabled !== false)
  .map((scenario) => scenario.code);
const scenarioFallbackSource = runner.match(
  /scenarioCodes:\s*\(shopRow\.scenario_codes\?\.length \? shopRow\.scenario_codes : \[([\s\S]*?)\]\)\.filter\([\s\S]*?\),\s*pddSecretPrefix/u,
);
assert.ok(scenarioFallbackSource, 'the dynamic-shop scenario fallback must remain explicit');
const workerFallbackScenarioCodes = [
  ...scenarioFallbackSource[1].matchAll(/'([^']+)'/gu),
].map((match) => match[1]);
const apiScenarioFallbackSource = apiDataBackend.match(
  /const defaultShopScenarioCodes = \[([\s\S]*?)\];/u,
);
assert.ok(apiScenarioFallbackSource, 'the API shop scenario fallback must remain explicit');
const apiFallbackScenarioCodes = [
  ...apiScenarioFallbackSource[1].matchAll(/'([^']+)'/gu),
].map((match) => match[1]);
assert.deepEqual(
  workerFallbackScenarioCodes,
  configuredScenarioCodes,
  'an empty dynamic-shop scenario list must fall back to every supported business type',
);
assert.deepEqual(
  apiFallbackScenarioCodes,
  configuredScenarioCodes,
  'frontend-created shops must enable every supported business type',
);
const pausedConfiguredScenarioCodes = scenarioConfig.scenarios
  .filter((scenario) => scenario.enabled !== false && scenario.processingEnabled === false)
  .map((scenario) => scenario.code);
assert.deepEqual(pausedConfiguredScenarioCodes, ['product-shortage'],
  'product-shortage must remain catalogued but processing-paused');
assert.match(runner, /pausedScenarioCodes\.has\(canonicalScenarioCode\(scenarioCode\)\)/u,
  'the worker must remove processing-paused scenarios from its claim list');
assert.equal(isTransientTmsOmsQueryMessage('查询中...'), true);
assert.equal(isTransientTmsOmsQueryMessage('<html><title>504 Gateway Time-out</title></html>'), true);
assert.equal(isTransientTmsOmsQueryMessage('502 Bad Gateway'), true);
assert.equal(isTransientTmsOmsQueryMessage('查询到 2 个订单，请选择对应订单'), false);
const stallPolicyNow = Date.parse('2026-08-19T16:00:00.000Z');
assert.equal(workflowStallExemption({ step: 'human-verification-required' }, stallPolicyNow),
  'operator-authentication');
assert.equal(workflowHeartbeatState('queue-empty', {
  step: 'queue-empty-waiting',
  verificationLocation: { status: 'waiting-human' },
}), 'human-verification-required', 'queue-empty must not hide a live verification challenge');
assert.equal(workflowHeartbeatState('queue-empty', {
  step: 'queue-empty-waiting',
  authHealth: { pdd: { status: 'verification-required' } },
}), 'human-verification-required', 'auth health must keep the verification state visible');
assert.equal(workflowHeartbeatState('queue-empty', {
  step: 'queue-empty-waiting',
  authHealth: { pdd: { status: 'authenticated' } },
}), 'queue-empty');
assert.equal(workflowHeartbeatState('browser-proxy-unavailable', {
  step: 'human-verification-required',
  verificationLocation: { status: 'waiting-human' },
}), 'browser-proxy-unavailable', 'proxy failure must identify the root cause instead of stale captcha state');
assert.equal(workflowAuthenticationState({
  step: 'manual-login-required',
  systemLogin: { system: 'oms' },
  verificationLocation: { system: 'pdd' },
  authHealth: { pdd: { status: 'authenticated' }, oms: { status: 'expired' } },
}).system, 'oms', 'manual OMS login must override stale PDD verification metadata');
assert.equal(workflowAuthenticationState({
  step: 'manual-login-required',
  systemLogin: { system: 'tms', status: 'authenticated' },
  authHealth: {
    pdd: { status: 'authenticated' },
    oms: { status: 'expired' },
    tms: { status: 'authenticated' },
  },
}).system, 'oms', 'an authenticated stale TMS marker must not hide the current OMS expiry');
assert.equal(workflowAuthenticationState({
  step: 'human-verification-required',
  systemLogin: { system: 'oms' },
  verificationLocation: { system: 'tms' },
  authHealth: { tms: { status: 'verification-required' } },
}).system, 'tms', 'human verification must belong to the page where the challenge is rendered');
assert.deepEqual(workflowAuthenticationState({
  authHealth: { pdd: { status: 'authenticated' }, oms: { status: 'expired' } },
  systemTabs: { activeSystem: 'pdd' },
}), {
  system: 'oms',
  health: { status: 'expired' },
  manualLoginRequired: false,
  humanVerificationRequired: false,
  blocked: true,
}, 'confirmed expired auth health must override an unrelated active tab');
assert.deepEqual(workflowAuthenticationState({
  step: 'manual-login-required',
  systemLogin: { system: 'oms', status: 'waiting-human' },
  authHealth: {
    pdd: { status: 'authenticated' },
    oms: { status: 'expired' },
    tms: { status: 'authenticated' },
  },
}, { requiredSystems: ['pdd'] }), {
  system: 'pdd',
  health: { status: 'authenticated' },
  manualLoginRequired: false,
  humanVerificationRequired: false,
  blocked: false,
}, 'an OMS login wait must not block PDD-only discovery and refund work');
assert.deepEqual(workflowAuthenticationState({
  step: 'human-verification-required',
  verificationLocation: { system: 'oms', status: 'waiting-human' },
  authHealth: {
    pdd: { status: 'authenticated' },
    oms: { status: 'verification-required' },
  },
}, { requiredSystems: ['pdd'] }), {
  system: 'pdd',
  health: { status: 'authenticated' },
  manualLoginRequired: false,
  humanVerificationRequired: false,
  blocked: false,
}, 'an OMS verification wait must not block PDD-only discovery and refund work');
assert.deepEqual(workflowAuthenticationState({
  step: 'return-refund-claim-complete',
  authHealth: { pdd: { status: 'verification-required' } },
  verificationLocation: { system: 'pdd', status: 'waiting-human' },
}), {
  system: 'pdd',
  health: { status: 'verification-required' },
  manualLoginRequired: false,
  humanVerificationRequired: false,
  blocked: true,
}, 'persisted PDD verification health must survive a stale completed business step');
assert.equal(workflowStallExemption({
  step: 'ordinary-scenario-stage-waiting',
  logisticsWait: { nextAttemptAt: '2026-08-21T16:00:00.000Z' },
}, stallPolicyNow), 'scheduled-business-wait');
assert.equal(workflowStallExemption({
  step: 'rate-limited-waiting',
  retryAfterAt: '2026-08-19T16:03:00.000Z',
}, stallPolicyNow), 'rate-limit-backoff');
assert.equal(workflowStallExemption({
  step: 'rate-limited-waiting',
  retryAfterAt: '2026-08-19T15:59:59.000Z',
}, stallPolicyNow), null, 'expired backoff must be eligible for stale runtime recovery');
assert.equal(workflowStallExemption({ step: 'pdd-resolution-submit-recheck-waiting' }, stallPolicyNow),
  null, 'ordinary page-result waits must not be exempt from stale runtime recovery');
assert.equal(workflowStallExemption({ step: 'tms-created-row-waiting' }, stallPolicyNow),
  null, 'render waits must not stay active forever merely because the step contains waiting');
assert.match(workflow,
  /for \(const system of \['pdd', 'oms', 'tms'\]\)[\s\S]*adoptLiveSystemAnchor\(system\)/,
  'the resident observer must reconcile every live system anchor without trusting stale progress first');
assert.match(runner,
  /waitForReturnRefundOutput[\s\S]*const progress = await readProgress\(\);[\s\S]*await checkpointActiveClaim\(progress\)/,
  'return-refund waits must persist browser progress instead of publishing heartbeat-only state');
assert.match(workflow, /type: 'workflow-progress-snapshot'/,
  'every browser progress transition must be pushed to the owning worker immediately');
assert.match(workflow,
  /page crashed\|target page, context or browser has been closed\|\(\?:pdd\|oms\|tms\) 标签页不可用/u,
  'a closed permanent system anchor must enter the same in-session recovery path as a renderer crash');
assert.match(workflow,
  /restoreAndAuthenticateSystemTabs\(readProgress\(\), \[\.\.\.systemsToRecover\]\)/,
  'a page crash must restore only the affected systems instead of resetting all three sessions');
assert.match(workflow,
  /const pddOnlyOrdinaryRecovery = Boolean\([\s\S]*scenarioDependencies\?\.pdd === true[\s\S]*scenarioDependencies\?\.oms !== true[\s\S]*scenarioDependencies\?\.tms !== true/,
  'a PDD-only ordinary scenario must not wait for OMS/TMS during page-crash recovery');
assert.match(workflow,
  /const assignRecoveredSystemPage = \(system, targetPage\)[\s\S]*derivedPages\.delete\(targetPage\)[\s\S]*derivedPageMeta\.delete\(targetPage\)/,
  'a recovered permanent system page must not remain classified as a derived popup');
assert.match(workflow,
  /commitTimeoutMs = Math\.max\(5_000, Math\.min\(30_000, pddRenderWaitMs\)\)/,
  'system navigation must retry after a bounded 30-second render window');
assert.match(workflow,
  /assignmentId: activeAssignmentId,[\s\S]*status: 'active'/,
  'resident progress must retain the database assignment that produced it');
assert.match(workflow,
  /if \(activeAssignmentId \|\| !residentCommandMode\)[\s\S]*logRunStep\('browser-started'[\s\S]*browserRuntime:/,
  'an unassigned resident browser restart must not replace the last business step');
assert.match(runner,
  /pending\.assignmentId !== activeClaim\.leaseToken[\s\S]*checkpointBrowserProgress\(pending\.progress, 'browser-ipc'\)/,
  'live progress synchronization must remain fenced by the active database lease');
assert.match(runner,
  /handleWorkflowProgressSnapshot[\s\S]*message\.assignmentId !== activeClaim\.leaseToken/,
  'browser progress messages from an old assignment must be rejected before queuing');
assert.match(runner,
  /progressMatchesActiveClaim[\s\S]*checkpointBrowserProgress\(progress, 'heartbeat-fallback'\)/,
  'worker heartbeats must converge browser progress even if an IPC update was missed');
assert.match(runner,
  /const checkpointClaim = activeClaim;[\s\S]{0,900}checkpointActiveClaim\(progress, \{ force: true, claim: checkpointClaim \}\)[\s\S]{0,500}workOrderId: checkpointClaim\.id/,
  'browser progress synchronization must retain one fenced claim snapshot across database awaits');
assert.match(runner,
  /browserProgressSync: \{ \.\.\.browserProgressSync \}/,
  'worker heartbeats must expose progress checkpoint diagnostics');
assert.match(runner,
  /repository\.hasValidLease[\s\S]*lastOutcome = 'lease-ended'/,
  'a normal completed claim must not be reported as a progress synchronization rejection');
const terminalVerificationRecoveryIndex = runner.indexOf(
  'repository.resolveTerminalReturnRefundVerifications({ shopId })',
);
const activeVerificationGateIndex = runner.indexOf('let activeVerification = await queryLatestActiveVerification()');
assert.ok(
  terminalVerificationRecoveryIndex >= 0
    && activeVerificationGateIndex > terminalVerificationRecoveryIndex,
  'terminal refund verification residue must be reconciled before the shop-wide verification gate',
);
const processOneIndex = runner.indexOf('async function processOne()');
const authenticationGateIndex = runner.indexOf('if (authentication.blocked)', processOneIndex);
const preAuthenticationRecoveryIndex = runner.indexOf(
  'ensurePreClaimVerificationBrowser(verification)',
  authenticationGateIndex,
);
const authenticationGateReturnIndex = runner.indexOf('await observeOnboardingProgress();', authenticationGateIndex);
assert.ok(
  processOneIndex >= 0
    && authenticationGateIndex > processOneIndex
    && preAuthenticationRecoveryIndex > authenticationGateIndex
    && authenticationGateReturnIndex > preAuthenticationRecoveryIndex,
  'a persisted PDD verification must restore its browser before authentication blocking returns',
);
assert.match(runner,
  /authentication\.system === 'pdd'[\s\S]{0,220}authentication\.humanVerificationRequired[\s\S]{0,160}authentication\.health\.status === 'verification-required'[\s\S]{0,260}ensurePreClaimVerificationBrowser\(verification\)/,
  'pre-authentication browser recovery must be limited to an active PDD verification challenge');
const verificationBrowserRecoveryIndex = runner.indexOf(
  'async function ensurePreClaimVerificationBrowser(verification)',
);
const detachedVerificationBrowserRecoveryIndex = runner.indexOf(
  "status: 'shop-verification-browser-restored'",
  verificationBrowserRecoveryIndex,
);
const boundVerificationCommandIndex = runner.indexOf(
  "action: 'restore-verification'",
  verificationBrowserRecoveryIndex,
);
assert.ok(
  verificationBrowserRecoveryIndex >= 0
    && detachedVerificationBrowserRecoveryIndex > verificationBrowserRecoveryIndex
    && boundVerificationCommandIndex > detachedVerificationBrowserRecoveryIndex,
  'a shop-level verification without a work order must restore its resident browser without inventing a work-order recovery command',
);
assert.match(runner,
  /if \(!residentBrowser \|\| !verificationId \|\| system !== 'pdd'\)[\s\S]{0,1800}if \(!workOrderId\)[\s\S]{0,360}externalActionsReplayed: false/,
  'detached PDD verification must keep its browser alive and never replay an external action');
const preAuthenticationGateSource = runner.slice(
  authenticationGateIndex,
  authenticationGateReturnIndex,
);
assert.doesNotMatch(preAuthenticationGateSource, /verification\?\.work_order_id/,
  'a shop-level PDD verification must not be skipped merely because no work order has been discovered yet');
assert.match(runner,
  /scenarioCodes: \['return-refund'\],[\s\S]{0,240}unresolvedEffectsOnly: true/,
  'a refund with a reserved or unknown effect must be reclaimed before discovery work');
assert.match(runner,
  /!ordinaryOpportunitySinceRefundTurn\) \{\s*claim = await claimEligibleOrdinary\(\);\s*\}\s*if \(mixedBusinessSlotSession\s*&& !claim[\s\S]{0,1800}unresolvedEffectsOnly: true/,
  'a resident shop must process its ordinary batch before due unresolved refund rechecks');
assert.match(runner,
  /hash === lastCheckpointHash && hash === lastDatabaseCheckpointHash/,
  'a locally hydrated snapshot must still converge to PostgreSQL once');
assert.match(runner,
  /localAssignmentMatchesClaim[\s\S]*currentIsNewer = [^\n]*localAssignmentMatchesClaim/,
  'claim hydration must not prefer a local snapshot written by an older assignment');
assert.match(workflow, /markUnexpectedForegroundPopup/);
assert.match(workflow, /normalizedZoomHosts/);
assert.match(workflow, /pddLastKnownGoodStatePath/,
  'PDD auth must retain a last-confirmed snapshot across browser restarts');
assert.match(workflow,
  /pddSnapshotConfirmed[\s\S]*writeJsonAtomic\(statePath, pddState\)[\s\S]*writeJsonAtomic\(pddLastKnownGoodStatePath, pddState\)/,
  'only a confirmed PDD state may replace the recoverable auth snapshot');
assert.match(workflow,
  /pddSnapshotConfirmed = hasPddStorageData\(pddState\)[\s\S]{0,100}hasUsablePddSessionCookie\(pddState\)[\s\S]{0,100}&& \(pddAuthenticated \|\| pddHealthAuthenticated\)/,
  'an explicit PDD login signal must not checkpoint a missing or near-expiry shop token');
assert.match(workflow,
  /allowedHosts: AUTH_STORAGE_HOSTS\.pdd[\s\S]*requirePddSession: true/,
  'PDD bootstrap state must be scoped and contain a usable shop session');
assert.match(workflow,
  /const context = await launchWorkerBrowser\(\);[\s\S]*restoreBrowserAuthFromSnapshots\([\s\S]{0,180}context,[\s\S]{0,80}savedStartupStorageState/,
  'persistent browsers must restore confirmed auth after launch and before business navigation');
assert.match(workflow,
  /sharedOmsStatePath[\s\S]*seedSharedOmsStorageState[\s\S]*replaceStartupAuthSystems[\s\S]*persistSharedOmsStorageState/,
  'shared OMS mode must seed, restore and refresh one confirmed cross-shop OMS snapshot');
assert.match(workflow,
  /resident-warm-tms-tab[\s\S]{0,260}ensureTmsLoginOnce\(tmsPage, context\)[\s\S]{0,260}resident-tms-startup-login/,
  'every resident shop must actively validate its permanent TMS login at startup');
assert.match(workflow,
  /residentOmsWarmupPromise = \(async \(\) => \{[\s\S]{0,1200}resident-warm-oms-tab[\s\S]{0,350}ensureOmsLogin\(omsPage, context, \{[\s\S]{0,160}residentWarmup: true[\s\S]{0,600}resident-oms-startup-login/,
  'every per-shop resident must validate its permanent OMS business page in the background');
assert.match(workflow, /OMS_RESIDENT_WARMUP_LOGIN_REQUIRED/,
  'background OMS warmup must defer a missing login without entering a claimed business wait');
assert.match(workflow, /OMS_RESIDENT_WARMUP_VERIFICATION_REQUIRED/,
  'background OMS warmup must defer verification without entering a claimed business wait');
assert.match(workflow,
  /if \(!options\.residentWarmup\) \{[\s\S]{0,220}stage: 'oms-login-retry'/,
  'background OMS network failures must not be mislabeled as confirmed login expiry');
assert.doesNotMatch(workflow,
  /launchPersistentContext[\s\S]{0,1600}storageState:/,
  'persistent launch options must not rely on the unsupported storageState field');
assert.doesNotMatch(workflow, /persistentProfileHasCookies/,
  'an unrelated persistent cookie file must not suppress last-good PDD restoration');
assert.doesNotMatch(workflow, /storageState\(\{ path: statePath \}\)/,
  'raw mixed-system storage must not overwrite the PDD auth snapshot');
assert.match(workflow,
  /persistBrowserAuth\(browserContext, \{ pddAuthenticated: true \}\)/,
  'a verified PDD login must explicitly checkpoint the confirmed session');
assert.doesNotMatch(workflow, /keepPopupBehindOpener/);
assert.match(workflow, /Target\.activateTarget/);
assert.match(workflow, /background-popup-focus-/);
const unexpectedPopupGuard = workflow.slice(
  workflow.indexOf('const markUnexpectedForegroundPopup'),
  workflow.indexOf('const browserRuntimeVersion'),
);
assert.doesNotMatch(unexpectedPopupGuard, /Target\.activateTarget/,
  'ordinary popups must never activate either the popup or its opener');
assert.match(pddBackgroundPopup, /anchor\.setAttribute\('target', '_self'\)/);
assert.match(pddBackgroundPopup, /window\.open = \(url\) =>/);
assert.match(pddBackgroundPopup, /window\.location\.assign\(targetUrl\)/);
assert.match(workflow, /openPddDetailWithoutForegroundPopup/);
assert.match(workflow, /clickPddActionWithoutForegroundPopup\(anchorPage, action\)/);
assert.match(returnRefund, /clickPddActionWithoutForegroundPopup/);
assert.match(returnRefund, /PDD_RETURN_REFUND_NOT_FOUND/);
assert.match(returnRefund, /outcome: 'skipped-not-found'/);
assert.match(returnRefund,
  /isReturnRefundExcludedDetailUrl\(detailPage\.url\(\)\)[\s\S]*return-refund-scan-non-refund-detail-skipped[\s\S]*continue;/,
  'a negative-experience appeal page must be skipped without consuming the refund render budget');
const postgresAdapter = await fsp.readFile(path.join(root, 'packages', 'adapters', 'src', 'postgres', 'index.mjs'), 'utf8');
assert.ok((postgresAdapter.match(/scenario_code IS DISTINCT FROM 'product-shortage'/gu) || []).length >= 5,
  'database queue eligibility, claim recovery, normal claiming, and deferred promotion must all reject product-shortage');
const dataBackend = await fsp.readFile(path.join(root, 'apps', 'api', 'src', 'data-backend.mjs'), 'utf8');
assert.match(postgresAdapter,
  /resolveTerminalReturnRefundVerifications[\s\S]*work_order\.status IN \('completed', 'archived'\)[\s\S]*refund\.action_state IN \('auto-refunded', 'manual-completed', 'skipped-not-found'\)/,
  'verification residue may be reconciled only from authoritative terminal refund state');
assert.match(postgresAdapter,
  /resolveTerminalReturnRefundVerifications[\s\S]*effect\.status IN \('reserved', 'unknown'\)[\s\S]*runtime\.lease_expires_at > now\(\)/,
  'verification residue recovery must preserve unresolved effects and valid leases');
assert.match(postgresAdapter,
  /if \(completed \|\| skippedNotFound\)[\s\S]{0,260}resolveTerminalReturnRefundVerifications[\s\S]{0,180}allowActiveLease: true/,
  'the fenced terminal refund transaction must clear its exact verification before releasing the lease');
assert.match(postgresAdapter,
  /NOT \$4::boolean OR EXISTS \([\s\S]*effect_type = 'pdd-return-refund'[\s\S]*status IN \('reserved','unknown'\)/,
  'the reconciliation-only claim must be enforced inside the locked database selection');
assert.doesNotMatch(postgresAdapter,
  /next_attempt_at <= now\(\)[\s\S]{0,360}\$4::boolean AND EXISTS \([\s\S]{0,260}effect_type = 'pdd-return-refund'[\s\S]{0,160}status IN \('reserved','unknown'\)/,
  'a reconciliation-only claim must not bypass a scheduled retry');
assert.match(postgresAdapter,
  /refund\.action_state = 'waiting-logistics'[\s\S]{0,320}refund\.next_check_at > refund\.last_scanned_at[\s\S]{0,160}refund\.last_scanned_at \+ make_interval\(secs => \$5\) <= now\(\)/,
  'a newly reached logistics deadline must be claimable while unchanged overdue scans remain rate limited');
assert.match(postgresAdapter,
  /owner_deleted_hold[\s\S]*work_order\.completion_state = 'pending'[\s\S]*refund\.action_state IN/,
  'runtime identity reconciliation may restore only pending owner-deleted refund states');
assert.match(postgresAdapter,
  /other_binding\.shop_id <> \$1[\s\S]*other_binding\.actual_shop_name = \$2/,
  'runtime exact-name relocation must reject an ambiguous current shop name');
assert.match(postgresAdapter,
  /effect\.effect_type = 'pdd-return-refund'[\s\S]*effect\.status = 'succeeded'/,
  'runtime identity reconciliation must not replay an already-succeeded refund effect');
assert.match(postgresAdapter,
  /other_refund\.aftersale_number = refund\.aftersale_number[\s\S]*other\.shop_id = \$1/,
  'runtime identity reconciliation must reject any target-shop aftersale duplicate');
assert.match(postgresAdapter,
  /UPDATE shop_runtime_state[\s\S]*current_work_order_id = NULL[\s\S]*lease_expires_at <= now\(\)/);
assert.match(postgresAdapter,
  /coalesce\(w\.payload->>'updatedAt', ''\) <= \$7::text/,
  'late browser snapshots must not move the database checkpoint backwards');
assert.match(dataBackend,
  /heartbeat\.metadata->>'currentOrderNumber' = current_order\.external_order_number[\s\S]*heartbeat\.metadata->>'workflowStep'/,
  'the dashboard may use live browser state only when it belongs to the current order');
const staging = await fsp.readFile(path.join(root, 'infra', 'docker', 'docker-compose.staging.yml'), 'utf8');
const production = await fsp.readFile(path.join(root, 'infra', 'docker', 'docker-compose.production.yml'), 'utf8');
const productionEnvExample = await fsp.readFile(path.join(root, '.env.production.example'), 'utf8');
const apiMain = await fsp.readFile(path.join(root, 'apps', 'api', 'src', 'main.mjs'), 'utf8');
const verificationView = await fsp.readFile(path.join(root, 'apps', 'web', 'src', 'features', 'verification', 'VerificationView.jsx'), 'utf8');
const shopsView = await fsp.readFile(path.join(root, 'apps', 'web', 'src', 'features', 'shops', 'ShopsView.jsx'), 'utf8');
const publicApp = await fsp.readFile(path.join(root, 'apps', 'web', 'src', 'app', 'PublicApp.jsx'), 'utf8');
const publicWorkOrderDrawer = await fsp.readFile(path.join(root, 'apps', 'web', 'src', 'components', 'PublicWorkOrderDrawer.jsx'), 'utf8');
const webServer = await fsp.readFile(path.join(root, 'apps', 'web', 'src', 'server.mjs'), 'utf8');
const nativeComponentRunner = await fsp.readFile(path.join(root, 'scripts', 'run-native-windows-component.ps1'), 'utf8');
const startScript = await fsp.readFile(path.join(root, 'scripts', 'start-staging.ps1'), 'utf8');
const stopScript = await fsp.readFile(path.join(root, 'scripts', 'stop-staging.ps1'), 'utf8');
const scannedIdentityMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '030_sync_scanned_shop_identity.sql'), 'utf8');
const omsManualAllocationMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '031_allow_oms_manual_allocation_effect.sql'), 'utf8');
const legacyRuntimeRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '032_recover_legacy_runtime_states.sql'), 'utf8');
const tmsMenuNavigationRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '050_recover_tms_menu_navigation_pauses.sql'), 'utf8');
const pddDetailClickRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '051_recover_pdd_detail_click_timeout.sql'), 'utf8');
const omsDetachedRowRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '052_recover_oms_detached_order_row.sql'), 'utf8');
const transientOmsRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '053_recover_transient_oms_pauses.sql'), 'utf8');
const misboundMedicalDeviceOrderMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '054_reassign_misbound_medical_device_order.sql'), 'utf8');
const invalidPddDetailRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '055_recover_invalid_pdd_detail_url.sql'), 'utf8');
const legacyMisboundMedicalDeviceOrderMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '056_reassign_legacy_misbound_medical_device_order.sql'), 'utf8');
const deliveryRiskRuleUpgradeRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '065_recover_delivery_risk_rule_upgrade_pauses.sql'), 'utf8');
const readonlyDatePickerRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '066_recover_readonly_date_picker_pauses.sql'), 'utf8');
const transientPageRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '067_recover_transient_page_render_pauses.sql'), 'utf8');
const tmsStandardizedEvidenceRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '068_recover_tms_standardized_evidence_pauses.sql'), 'utf8');
const deliveryRiskFinalResultRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '069_recover_delivery_risk_final_result_pauses.sql'), 'utf8');
const semanticPddOptionRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '071_recover_semantic_pdd_option_pauses.sql'), 'utf8');
const returnRefundPageRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '072_recover_transient_return_refund_page_errors.sql'), 'utf8');
const completedPageOutcomeRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '073_recover_completed_page_outcome_mismatch.sql'), 'utf8');
const omsLoginDeferredRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '078_recover_oms_login_deferred_pauses.sql'), 'utf8');
const optionalRecallEvidenceRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '079_recover_optional_recall_evidence_pauses.sql'), 'utf8');
const optionalSubjectiveInterceptEvidenceRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '080_recover_optional_subjective_intercept_evidence_pauses.sql'), 'utf8');
const optionalEvidenceFollowupRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '081_recover_optional_evidence_followup_pauses.sql'), 'utf8');
const exactEmptyResultRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '087_recover_exact_empty_pending_query_pauses.sql'), 'utf8');
const createdTimeLowerBoundRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '088_recover_missing_work_order_created_at_pauses.sql'), 'utf8');
const subjectiveRefundOutcomeAliasRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '082_recover_subjective_refund_outcome_alias_pauses.sql'), 'utf8');
const readableWarehouseRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '083_recover_readable_warehouse_scope_pauses.sql'), 'utf8');
const readableTmsDuplicateRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '084_recover_readable_tms_duplicate_pauses.sql'), 'utf8');
const distinctTmsSuborderRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '093_recover_distinct_tms_suborder_pauses.sql'), 'utf8');
const crossShopAbsentPendingRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '094_recover_cross_shop_absent_pending_archive.sql'), 'utf8');
const pddMallIdentityMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '095_pdd_mall_identity.sql'), 'utf8');
const defenceShopIdentityMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '096_recover_defense_shop_identity.sql'), 'utf8');
const completedDuringOptionSelectionMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '097_recover_completed_during_option_selection.sql'), 'utf8');
const pddOrderRemarkLoginRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '098_recover_pdd_order_remark_login_pauses.sql'), 'utf8');
const subjectiveRefundFallbackRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '099_recover_subjective_refund_fallback_pauses.sql'), 'utf8');
const legacyPendingRenderRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '100_recover_legacy_pending_render_pauses.sql'), 'utf8');
const unrefreshedEmptyRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '101_recover_unrefreshed_empty_pending_pauses.sql'), 'utf8');
const mismatchedExistingTmsDecisionRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '102_recover_mismatched_existing_tms_decisions.sql'), 'utf8');
const reappliedMismatchedTmsDecisionRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '103_reapply_mismatched_tms_decision_recovery.sql'), 'utf8');
const consumerNegotiationFollowupRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '105_recover_applied_intercept_progress_transitions.sql'), 'utf8');
const terminalReturnRefundRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '106_recover_terminal_return_refund_manual_reviews.sql'), 'utf8');
const ordinaryFirstDiscoveredRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '107_recover_ordinary_first_discovered_pauses.sql'), 'utf8');
const tmsPostalCarrierAliasRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '108_recover_tms_postal_carrier_alias_pauses.sql'), 'utf8');
const refreshedExactEmptyRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '109_recover_refreshed_exact_empty_completion_pauses.sql'), 'utf8');
const recoveredCompletionEvidenceCleanupMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '110_recover_completed_orphan_evidence_pauses.sql'), 'utf8');
const recoveredCompletionMetricMarkerMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '111_backfill_recovered_completion_metric_marker.sql'), 'utf8');
const noLogisticsReturnRefundRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '112_recover_no_logistics_return_refund_reviews.sql'), 'utf8');
const actionableReturnRefundRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '113_recover_actionable_return_refund_reviews.sql'), 'utf8');
const terminalReturnRefundWithoutTypeRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '114_recover_terminal_return_refunds_without_type.sql'), 'utf8');
const extendedDetailShellRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '115_recover_extended_ordinary_detail_shell_pauses.sql'), 'utf8');
const refreshedRequestedOrderAbsenceRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '116_recover_refreshed_requested_order_absence.sql'), 'utf8');
const returnRefundAgingPolicyRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '117_recover_return_refund_aging_policy_reviews.sql'), 'utf8');
const returnRefundRenderTimeoutRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '118_reclassify_return_refund_render_timeouts.sql'), 'utf8');
const pddNavigationTimeoutRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '121_recover_pdd_navigation_timeout_pauses.sql'), 'utf8');
const standaloneTerminalReturnRefundRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '122_recover_standalone_terminal_return_refunds.sql'), 'utf8');
const readOnlyReturnRefundClassificationMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '123_classify_readonly_return_refund_recoveries.sql'), 'utf8');
const unavailableRefundActionRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '124_recover_unavailable_no_logistics_refund_actions.sql'), 'utf8');
const ordinaryDecisionFormRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '125_recover_unexpanded_ordinary_decision_forms.sql'), 'utf8');
const unconfirmedOrdinarySubmitRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '126_recover_unconfirmed_ordinary_submissions.sql'), 'utf8');
const terminalStaleReservationMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '127_quarantine_terminal_stale_external_reservations.sql'), 'utf8');
const singleSubmitNoRetryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '131_reconcile_single_submit_without_retry.sql'), 'utf8');
const exhaustedSubmitManualMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '132_mark_exhausted_submit_reconciliation_manual.sql'), 'utf8');
const interruptedPddNoteReconciliationMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '133_recover_interrupted_pdd_note_reconciliation.sql'), 'utf8');
const pddNoteListRedirectRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '134_recover_pdd_note_reconciliation_list_redirect.sql'), 'utf8');
const rollingReloadPddNoteRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '135_recover_rolling_reload_pdd_note_reconciliation.sql'), 'utf8');
const tmsAttachmentResponseTimeoutRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '136_recover_tms_attachment_response_timeout.sql'), 'utf8');
const omsManualAllocationRenderRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '137_recover_oms_manual_allocation_render_pauses.sql'), 'utf8');
const windowsAbnormalExitRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '138_recover_windows_abnormal_workflow_exits.sql'), 'utf8');
const returnRefundStatusKeywordRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '139_recover_return_refund_status_keyword_reviews.sql'), 'utf8');
const ordinaryDetailRenderTimeoutRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '140_recover_ordinary_detail_render_timeout.sql'), 'utf8');
const shortDeliveryAddressFieldLocatorRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '202_recover_short_delivery_address_field_locator_failures.sql'), 'utf8');
const deliveryFieldFallbackBudgetMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '203_reset_delivery_field_fallback_retry_budget.sql'), 'utf8');
const ordinaryDetailOrderNumberReadRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '141_recover_ordinary_detail_order_number_read_pauses.sql'), 'utf8');
const abnormalNetworkAllocatedWithoutRecommendationRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '142_recover_abnormal_network_allocated_without_recommendation.sql'), 'utf8');
const missingReturnRefundArchiveMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '143_archive_missing_return_refunds.sql'), 'utf8');
const deliveryRiskStagedFormRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '144_recover_delivery_risk_staged_form_pauses.sql'), 'utf8');
const directSubjectiveRefundRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '145_recover_direct_subjective_refund_pauses.sql'), 'utf8');
const deliveryRiskConfirmButtonRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '146_recover_delivery_risk_confirm_button_pauses.sql'), 'utf8');
const omsOrderManagementRenderRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '147_recover_oms_order_management_render_pauses.sql'), 'utf8');
const unrelatedReturnRefundTerminalTextRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '148_recover_unrelated_return_refund_terminal_text.sql'), 'utf8');
const refundSubmissionReconciliationRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '149_recover_refund_submission_reconciliation.sql'), 'utf8');
const staleSavedDetailAbsenceRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '150_recover_stale_saved_detail_absence_loops.sql'), 'utf8');
const uncertainReturnRefundEffectRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '151_recover_actionable_uncertain_return_refund_effects.sql'), 'utf8');
const returnedGoodsOptionAliasRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '156_recover_returned_goods_option_alias_pauses.sql'), 'utf8');
const proactiveTwoLevelFormRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '157_recover_proactive_logistics_two_level_form_pauses.sql'), 'utf8');
const absentProactiveEvidenceControlRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '158_recover_absent_proactive_evidence_control_pauses.sql'), 'utf8');
const transientSubjectiveStateChangeRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '159_recover_subjective_state_change_rejections.sql'), 'utf8');
const completedInterceptLowValueRefundRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '160_recover_completed_intercept_low_value_refund.sql'), 'utf8');
const deterministicOrdinaryPauseRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '163_recover_deterministic_ordinary_pauses.sql'), 'utf8');
const ownerDeletedReturnRefundIdentityRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '164_restore_owner_deleted_return_refund_identity.sql'), 'utf8');
const terminalAndTransientOrdinaryPauseRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '175_recover_terminal_and_transient_ordinary_pauses.sql'), 'utf8');
const ordinarySubmitRenderRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '176_recover_ordinary_submit_render_pauses.sql'), 'utf8');
const directRefundOptionAliasRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '177_recover_direct_refund_option_alias_pauses.sql'), 'utf8');
const deliveredAddressNoClickRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '178_recover_delivered_address_no_click_submit.sql'), 'utf8');
const legacyUnclickedSecondAttemptRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '179_recover_legacy_unclicked_second_submit_attempts.sql'), 'utf8');
const transientOmsTmsQueryRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '181_recover_transient_oms_tms_query_pauses.sql'), 'utf8');
const terminalInterventionGuardMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '182_prevent_terminal_intervention_reopen.sql'), 'utf8');
const returnRefundLoginVerificationMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '183_reclassify_return_refund_login_page_errors.sql'), 'utf8');
const failedReadOnlyReconciliationRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '184_recover_failed_read_only_reconciliations.sql'), 'utf8');
const safeOrdinaryIdentityRebindMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '186_rebind_safe_deterministic_ordinary_retries.sql'), 'utf8');
const lateUnclickedRecallOptionRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '187_recover_late_unclicked_recall_option.sql'), 'utf8');
const counterpartyPendingReturnRefundRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '188_recover_counterparty_pending_return_refund_page_errors.sql'), 'utf8');
const preSubmitVerificationRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '189_recover_pre_submit_verification_pauses.sql'), 'utf8');
const staleDetailIdentityRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '190_recover_exact_identity_stale_detail_pauses.sql'), 'utf8');
const exactShipmentTmsWarehouseRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '191_recover_exact_shipment_tms_warehouse_conflicts.sql'), 'utf8');
const remainingDeterministicOrdinaryRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '192_recover_remaining_deterministic_ordinary_pauses.sql'), 'utf8');
const auditedOrdinaryReconciliationMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '193_resume_audited_ordinary_reconciliation.sql'), 'utf8');
const definitivePddStateChangeRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '194_recover_definitive_pdd_state_change_rejections.sql'), 'utf8');
const postDependencyVerificationRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '195_recover_post_dependency_verification_pauses.sql'), 'utf8');
const completedReturnTmsDecisionRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '196_recover_completed_return_tms_decision_pauses.sql'), 'utf8');
const returnRefundScanRestoreMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '197_restore_return_refund_scanning.sql'), 'utf8');
const safeOrdinaryParserAndBodyTimeoutRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '198_recover_safe_ordinary_parser_and_body_timeouts.sql'), 'utf8');
const consumerNegotiationDirectResumeMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '206_resume_consumer_negotiation_followups_without_tms_replay.sql'), 'utf8');
const consumerNegotiationCompletionFinalizeMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '207_finalize_confirmed_consumer_negotiation_followups.sql'), 'utf8');
const alreadyConfirmedConsumerNegotiationFinalizeMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '208_finalize_already_confirmed_consumer_negotiation_followups.sql'), 'utf8');
const consumerNegotiationRaceRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '209_recover_consumer_negotiation_followup_race.sql'), 'utf8');
const terminalOmsManualAllocationRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '210_recover_terminal_oms_manual_allocation_pauses.sql'), 'utf8');
const resolvedVerificationBackoffRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '211_resume_resolved_verification_backoffs.sql'), 'utf8');
const consumerNegotiationMissingEvidenceRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '212_recover_consumer_negotiation_missing_evidence_disposition.sql'), 'utf8');
const ordinaryDetailFreshQueryRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '213_recover_stale_ordinary_detail_render_loop.sql'), 'utf8');
const omsReissueRenderRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '214_recover_oms_reissue_render_pauses.sql'), 'utf8');
const omsReissueDomDiagnosticRetryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '215_retry_oms_reissue_with_dom_diagnostics.sql'), 'utf8');
const omsReissueDoubleClickPickerRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '278_recover_oms_reissue_double_click_picker.sql'), 'utf8');
const omsFlatBatchReissueRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '279_recover_oms_flat_batch_reissue_variant.sql'), 'utf8');
const postUpgradePddLoginPauseRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '288_recover_post_upgrade_pdd_login_pause.sql'), 'utf8');
const overlayPostUpgradePddLoginPauseRecoveryMigration = await fsp.readFile(path.join(root, 'patches', '162_new_ordinary_scenarios', 'overlay', 'infra', 'db', 'migrations', '288_recover_post_upgrade_pdd_login_pause.sql'), 'utf8');
const orphanedTmsCreateReconciliationMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '216_reconcile_orphaned_tms_create_effects.sql'), 'utf8');
const reverseLogisticsSignedRefundMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '217_add_reverse_logistics_signed_refund.sql'), 'utf8');
const strictOmsWarehouseScopeMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '218_enforce_oms_warehouse_scope.sql'), 'utf8');
const expandedOmsWarehouseScopeMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '219_expand_oms_warehouse_scope.sql'), 'utf8');
const abnormalNetworkWarehouseGuardRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '224_recover_abnormal_network_warehouse_guard.sql'), 'utf8');
const pddRemarkColorRerenderRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '225_recover_pdd_remark_color_rerender.sql'), 'utf8');
const omsOrderRowSelectionRerenderRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '226_recover_oms_order_row_selection_rerender.sql'), 'utf8');
const duplicateTmsFirstRowReconciliationMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '227_reconcile_duplicate_tms_rows_by_first_match.sql'), 'utf8');
const consumerResponseWaitReclassificationMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '228_reclassify_consumer_response_waits.sql'), 'utf8');
const safePddDetailReloadAndRebindMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '220_recover_safe_pdd_detail_reload_and_rebind.sql'), 'utf8');
const sparsePddDetailRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '221_recover_sparse_pdd_detail_and_render_pauses.sql'), 'utf8');
const pddAnchorUnavailableRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '237_recover_pdd_anchor_unavailable.sql'), 'utf8');
const consumerNegotiationPrimaryRefundEvidenceRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '238_recover_consumer_negotiation_primary_refund_evidence_pause.sql'), 'utf8');
const proactiveIframeFinalSubmitRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '239_recover_proactive_iframe_final_submit.sql'), 'utf8');
const visiblePddEvidenceUploadCanaryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '240_canary_visible_pdd_evidence_upload.sql'), 'utf8');
const postSubmitReferenceErrorArchiveMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '241_archive_post_submit_reference_error.sql'), 'utf8');
const proactiveIframeSubmitReconciliationRetryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '242_retry_proactive_iframe_submit_reconciliation.sql'), 'utf8');
const pddEvidenceBucketFallbackCanaryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '243_canary_pdd_evidence_bucket_fallback.sql'), 'utf8');
const pddEvidenceBucketFallbackReceiptRetryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '244_retry_pdd_evidence_bucket_fallback_canary.sql'), 'utf8');
const pddEvidenceReceiptConfirmationCanaryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '245_canary_pdd_evidence_receipt_confirmation.sql'), 'utf8');
const pddEvidence48143FirstBatchMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '246_recover_pdd_evidence_48143_first_batch.sql'), 'utf8');
const pddEvidence48143RemainingSafeMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '247_recover_pdd_evidence_48143_remaining_safe.sql'), 'utf8');
const stalePddEvidence48143RecaptureCanaryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '256_canary_recapture_stale_pdd_evidence_48143.sql'), 'utf8');
const remainingStalePddEvidence48143RecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '257_recover_remaining_stale_pdd_evidence_48143.sql'), 'utf8');
const clickedOrSucceededPddEvidence48143ReconciliationMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '258_reconcile_clicked_or_succeeded_pdd_evidence_48143.sql'), 'utf8');
const manualPddEvidence48143RecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '259_recover_unclicked_manual_pdd_evidence_48143.sql'), 'utf8');
const remainingClickedPddSubmissionReconciliationMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '260_reconcile_remaining_clicked_pdd_submissions.sql'), 'utf8');
const submitCompleteButtonPauseRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '290_recover_submit_complete_button_pause.sql'), 'utf8');
const verifiedProactiveFrameSubmitPauseRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '291_recover_verified_proactive_frame_submit_pauses.sql'), 'utf8');
const deliveryRiskConsumerConfirmationMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '292_reclassify_delivery_risk_consumer_confirmation.sql'), 'utf8');
const deliveredContactDateValidationRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '263_recover_delivered_contact_date_validation.sql'), 'utf8');
const interruptedContactDateRetryReconciliationMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '264_reconcile_interrupted_contact_date_retry.sql'), 'utf8');
const productShortageDatePickerRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '275_recover_product_shortage_date_picker.sql'), 'utf8');
const overlayProductShortageDatePickerRecoveryMigration = await fsp.readFile(path.join(root, 'patches', '162_new_ordinary_scenarios', 'overlay', 'infra', 'db', 'migrations', '275_recover_product_shortage_date_picker.sql'), 'utf8');
const productShortageDateFrameRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '276_recover_product_shortage_date_frame_lookup.sql'), 'utf8');
const overlayProductShortageDateFrameRecoveryMigration = await fsp.readFile(path.join(root, 'patches', '162_new_ordinary_scenarios', 'overlay', 'infra', 'db', 'migrations', '276_recover_product_shortage_date_frame_lookup.sql'), 'utf8');
const productShortageTmsEffectRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '277_rehydrate_product_shortage_tms_effect.sql'), 'utf8');
const overlayProductShortageTmsEffectRecoveryMigration = await fsp.readFile(path.join(root, 'patches', '162_new_ordinary_scenarios', 'overlay', 'infra', 'db', 'migrations', '277_rehydrate_product_shortage_tms_effect.sql'), 'utf8');
const interruptedPerShopOmsLoginRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '266_recover_interrupted_per_shop_oms_login.sql'), 'utf8');
const omsMarkVirtualizedRowRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '267_recover_oms_mark_virtualized_row.sql'), 'utf8');
const relocatedAbnormalNetworkCompletionArchiveMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '268_archive_relocated_abnormal_network_completion.sql'), 'utf8');
const supersededShopLevelInterventionReconciliationMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '269_reconcile_superseded_shop_level_interventions.sql'), 'utf8');
const liveRuntimeAudit = await fsp.readFile(path.join(root, 'scripts', 'live-runtime-audit.mjs'), 'utf8');
const confirmedDirectSubmitOutcomeTextMismatchArchiveMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '250_archive_confirmed_direct_submit_outcome_text_mismatch.sql'), 'utf8');
const omsReissueAdapter = await fsp.readFile(path.join(root, 'packages', 'adapters', 'src', 'oms', 'reissue.mjs'), 'utf8');
const legacyTmsInterceptRemarkRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '085_recover_legacy_tms_intercept_remark_pauses.sql'), 'utf8');
const globalWorkOrderUniquenessMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '033_enforce_global_work_order_uniqueness.sql'), 'utf8');
const tmsCreatedRowRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '034_recover_tms_created_row_visibility.sql'), 'utf8');
const reconciledPddRemarkRecoveryMigration = await fsp.readFile(path.join(root, 'infra', 'db', 'migrations', '046_recover_confirmed_pdd_remark_continuation.sql'), 'utf8');

const sanitizedJsonb = JSON.parse(stringifyJsonb({
  maskedRecipient: `收货人 ${String.fromCharCode(0xD83C)}*`,
  embeddedNull: `prefix${String.fromCharCode(0)}suffix`,
  validEmoji: '😀',
}));
assert.equal(sanitizedJsonb.maskedRecipient, '收货人 �*');
assert.equal(sanitizedJsonb.embeddedNull, 'prefix�suffix');
assert.equal(sanitizedJsonb.validEmoji, '😀');

assert.match(runner, /WORKER_MAX_ORDERS \|\| 0/);
assert.match(runner, /maxOrders === 0/);
assert.match(runner, /const readOnlyReview = refund\.action_state === 'manual-review'/);
assert.match(runner, /return-refund-no-logistics-over-72-hours/);
assert.match(runner, /return-refund-latest-logistics-stale/);
assert.match(runner, /return-refund-direction-timeout/);
assert.match(runner, /&& !autoPolicyReevaluation/);
assert.match(runner, /autoApproveEnabled: readOnlyReview \? false : returnRefundAutoApproveEnabled/);
assert.match(runner, /classifyDetachedClearedReturnRefundVerification/);
assert.match(runner, /resolveDetachedClearedReturnRefundVerification/);
assert.match(runner, /classifyStalePreClaimVerificationGate/);
assert.match(runner, /resolveStaleDetachedPddVerificationGate/);
assert.match(runner, /classifyStaleBoundPreClaimVerificationGate/);
assert.match(runner, /resolveStaleBoundPddVerificationGate/);
assert.match(runner,
  /resolveStaleBoundOrdinaryPddVerificationGate\(\{[\s\S]{0,220}identityBindingToken: currentPddIdentityBindingToken/,
  'ordinary bound verification recovery must use the current confirmed shop binding');
assert.match(runner, /stale-bound-pdd-verification-reconciled/);
assert.match(postgresAdapter,
  /async resolveStaleBoundPddVerificationGate[\s\S]*work_order\.scenario_code = 'return-refund'[\s\S]*work_order\.current_step = 'return-refund-verification-required'[\s\S]*refund\.action_state = 'verification-required'/,
  'bound gate recovery must target only the exact retryable return/refund verification state');
assert.match(postgresAdapter,
  /resolveStaleBoundPddVerificationGate[\s\S]*verificationLocation,id[\s\S]*= ''[\s\S]*runtime\.lease_expires_at > now\(\)[\s\S]*external_effects effect[\s\S]*WHERE effect\.work_order_id = work_order\.id/,
  'bound gate recovery must reject a current challenge, an active lease, or any prior external effect');
assert.match(postgresAdapter,
  /stale-bound-pdd-verification-reconciled[\s\S]*detached-bound-return-refund-read-only-reevaluation[\s\S]*externalActionsReplayed', false/,
  'bound gate recovery must record an auditable read-only reevaluation without replay');
assert.match(postgresAdapter,
  /async resolveStaleBoundOrdinaryPddVerificationGate[\s\S]*scenario_code IS DISTINCT FROM 'return-refund'[\s\S]*scenario_code IS DISTINCT FROM 'product-shortage'[\s\S]*identity_status = 'verified'/,
  'ordinary bound recovery must exclude return/refund and product-shortage and require verified identity');
assert.match(postgresAdapter,
  /resolveStaleBoundOrdinaryPddVerificationGate[\s\S]*binding\.binding_token::text = \$8::text[\s\S]*identity\.status = 'confirmed'[\s\S]*pddIdentityBindingToken}' = \$8::text[\s\S]*pddIdentityBindingToken}' = \$8::text/,
  'ordinary bound recovery must compare the UUID binding and JSON text identities without a PostgreSQL text/uuid type mismatch');
assert.doesNotMatch(postgresAdapter,
  /resolveStaleBoundOrdinaryPddVerificationGate[\s\S]*binding\.binding_token = \$8::uuid[\s\S]*pddIdentityBindingToken}' = \$8(?!::text)/,
  'ordinary bound recovery must not infer the shared binding parameter as UUID before comparing it with JSON text');
assert.match(postgresAdapter,
  /resolveStaleBoundOrdinaryPddVerificationGate[\s\S]*runtime\.lease_expires_at > now\(\)[\s\S]*effect\.status <> 'succeeded'[\s\S]*'pdd-submit','pdd-return-refund'/,
  'ordinary bound recovery must reject uncertain or terminal PDD effects and active leases');
assert.match(postgresAdapter,
  /stale-bound-ordinary-pdd-verification-reconciled[\s\S]*existingSucceededEffectsPreserved[\s\S]*externalActionsReplayed', false/,
  'ordinary recovery must preserve successful prior effects and record that none were replayed');
assert.match(runner, /ensurePreClaimVerificationBrowser\(verification\)/);
assert.match(runner, /action: 'restore-verification'/);
assert.match(workflow, /runRestoredVerificationRecoveryOnly/);
assert.match(workflow, /externalActionsReplayed: false/);
assert.doesNotMatch(workflow, /restore-verification[\s\S]{0,160}writePddDiscoveryOutput/);
assert.match(runner, /preClaimVerificationGate/);
assert.match(workflow, /readOnlyReview: command\.readOnlyReview === true/);
assert.match(workflow, /readOnlyReview: command\.readOnlyReview/);
assert.match(workflow, /lastVerificationResidentCommand/);
assert.doesNotMatch(runner, /resident-browser-waiting/);
assert.match(runner, /claimPendingCommand/);
assert.match(runner, /WORKFLOW_EXTERNAL_EFFECT_GUARD/);
assert.match(runner, /hydrateClaimProgress\(claim\)/);
assert.match(runner, /hydrateClaimProgress\(reconciliationClaim, \{ clearExternalStateReconciliation: true \}\)/);
assert.match(runner, /const verifiedPddDetailUrlForOrdinaryIdentity/);
assert.match(runner, /detailUrl: businessProgress\.detailUrl \|\| verifiedDetailUrl \|\| null/);
assert.match(runner, /if \(clearExternalStateReconciliation\) delete hydrated\.externalStateReconciliation/);
assert.match(runner, /function withConfirmedPddRemark/);
assert.match(runner, /hydrated = withConfirmedPddRemark\(hydrated\)/);
assert.match(runner, /const nextProgress = withConfirmedPddRemark\(/);
assert.match(runner, /repository\.recoverSafeUnconfirmedPddSubmissions\(\{ shopId \}\)/);
assert.match(runner, /unconfirmed-pdd-submit-reconciliation-recovered/);
assert.match(runner, /read-only-pdd-state-reconciliation-no-resubmit/);
assert.match(postgresAdapter, /async recoverSafeUnconfirmedPddSubmissions\(\{ shopId, maxAttempts = 2 \}\)/);
assert.match(postgresAdapter, /candidate\.effect_type = 'pdd-submit'/);
assert.match(postgresAdapter, /candidate\.status = 'succeeded'/);
assert.match(postgresAdapter, /unresolved\.status IN \('reserved', 'unknown'\)/);
assert.match(postgresAdapter, /unconfirmed-pdd-submit-reconciliation-recovered/);
assert.match(postgresAdapter, /work_order\.current_step = 'external-state-reconciliation-failed'/);
assert.match(postgresAdapter, /\(fill\|waitFor\)/);
assert.match(postgresAdapter, /unconfirmedPddSubmissionRecovery,recoveryAttempts/);
assert.match(postgresAdapter, /'maxRecoveryAttempts', \$2::int/);
assert.match(postgresAdapter,
  /pddResolutionSubmission,effectStage[\s\S]*right\([\s\S]*effect\.idempotency_key/,
  'unconfirmed submit recovery must target the current stage even when earlier staged submits succeeded');
assert.doesNotMatch(postgresAdapter,
  /submit_effect\.effect_type = 'pdd-submit'[\s\S]{0,260}\) = 1/,
  'legitimate multi-stage PDD submit history must not block read-only reconciliation');
assert.match(workflow,
  /PDD_SUBMIT_OUTCOME_UNCONFIRMED[\s\S]{0,500}transitionConfirmed/,
  'a final click without response or terminal transition must remain unknown for read-only reconciliation');
assert.match(workflow,
  /collectPddRequest[\s\S]*targetPage\.on\('request', collectPddRequest\)[\s\S]*targetPage\.on\('response', collectPddResponse\)[\s\S]*targetPage\.on\('requestfailed', collectPddRequestFailure\)[\s\S]*targetPage\.on\('framenavigated', collectPddFrameNavigation\)[\s\S]*requestCandidates[\s\S]*uiFeedback/,
  'PDD submit diagnostics must retain requests, responses, failures, navigation and UI validation evidence');
assert.match(workflow,
  /requiredSelectedPddOptions[\s\S]*verifyPddSubmitSelections[\s\S]*pddSubmitSelectionProof/,
  'PDD submit must prove every required radio selection immediately before the click');
assert.match(workflow, /PDD_ACTION_DELAY_MS \|\| '900'/);
assert.match(workflow, /OMS_ACTION_DELAY_MS \|\| '250'/);
assert.match(workflow, /TMS_ACTION_DELAY_MS \|\| '250'/);
assert.match(workflow, /const actionDelayFor =/);
assert.match(production, /WORKER_POLL_INTERVAL_MS: \$\{WORKER_POLL_INTERVAL_MS:-2000\}/);
assert.match(production, /PDD_DISCOVERY_INTERVAL_MS: \$\{PDD_DISCOVERY_INTERVAL_MS:-60000\}/);
assert.match(production, /PDD_ACTION_DELAY_MS: \$\{PDD_ACTION_DELAY_MS:-900\}/);
assert.match(staging, /WORKER_POLL_INTERVAL_MS: \$\{WORKER_POLL_INTERVAL_MS:-2000\}/);
assert.match(staging, /PDD_DISCOVERY_INTERVAL_MS: \$\{PDD_DISCOVERY_INTERVAL_MS:-60000\}/);
assert.match(staging, /PDD_ACTION_DELAY_MS: \$\{PDD_ACTION_DELAY_MS:-900\}/);
assert.match(runner, /checkpointActiveClaim/);
assert.match(runner, /logisticsWaitReleaseForClaim/);
assert.match(runner, /const logisticsWaitBelongsToClaim/);
assert.match(runner,
  /releasedDeferredWaitSteps = new Set\(\[[\s\S]*'logistics-waiting-released'[\s\S]*'consumer-response-waiting-released'/,
  'the durable wait handoff must accept logistics and consumer-response checkpoints');
assert.match(runner, /platformWorkOrderIdFromDetailUrl\(wait\.detailUrl\)/);
assert.match(runner, /checkpointSource: authoritativeRecoveryPayload \? 'postgres-authoritative-recovery'[\s\S]*localLogisticsWait \? 'local-logistics-wait'/);
assert.match(runner, /hydratedProgress\.checkpointSource === 'local-logistics-wait'/);
assert.match(runner, /!releasedDeferredWaitSteps\.has\(progress\?\.step\)/);
assert.match(runner, /progressUpdatedAtMs <= hydratedAtMs/);
assert.match(runner, /status: 'retry-ready',[\s\S]*currentStep,[\s\S]*nextAttemptAt: logisticsRelease\.nextAttemptAt/);
assert.match(runner, /workOrderType: claim\.work_order_type \|\| wait\.workOrderType/);
assert.match(runner, /logistics-wait-released/);
assert.match(runner, /consumer-response-wait-released/);
assert.match(
  runner,
  /mixedBusinessSlotSession[\s\S]{0,240}!startupLeaseRecoveryPending[\s\S]{0,240}ordinaryOpportunitySinceRefundTurn[\s\S]{0,900}scenarioCodes: \['return-refund'\]/,
  'ordinary and recovery sessions must give an overdue refund batch a turn after an ordinary scheduling opportunity',
);
assert.match(
  runner,
  /const mixedBusinessSlotSession = !slotSession[\s\S]{0,120}persistentSlotSession[\s\S]{0,160}boundedSlotSession[\s\S]{0,120}\['ordinary', 'recovery'\]\.includes\(assignmentKind\)/,
  'direct workers plus bounded ordinary and recovery slots must participate in refund fairness',
);
assert.match(
  runner,
  /if \(boundedSlotSession\)[\s\S]{0,700}mixedBusinessSlotSession[\s\S]{0,180}boundedRefundFairnessContinuationUsed[\s\S]{0,180}ordinaryOpportunitySinceRefundTurn[\s\S]{0,120}continue/,
  'bounded ordinary and recovery slots must allow one extra refund fairness turn before exiting',
);
assert.match(
  runner,
  /directRefundExecutionSession && processedWork[\s\S]{0,160}boundedDirectRefundClaimsProcessed \+= 1[\s\S]{0,160}returnRefundCombinedBatchItems[\s\S]{0,80}continue/,
  'dedicated refund sessions must process a bounded batch before closing the browser',
);
assert.match(
  runner,
  /persistentSlotSession[\s\S]{0,120}processedWork[\s\S]{0,120}lastProcessedScenarioCode === 'return-refund'[\s\S]{0,180}residentDirectRefundClaimsProcessed < returnRefundCombinedBatchItems[\s\S]{0,40}continue/,
  'resident shop workers must process a bounded refund batch without a poll delay between claims',
);
const unresolvedRefundClaimAt = runner.indexOf('unresolvedEffectsOnly: true');
const precedingRefundFairnessAt = runner.lastIndexOf(
  'const scanBeforeDirectClaim = shouldPrioritizeReturnRefundScan({',
  unresolvedRefundClaimAt,
);
assert.ok(
  unresolvedRefundClaimAt >= 0
    && precedingRefundFairnessAt >= 0
    && unresolvedRefundClaimAt - precedingRefundFairnessAt < 1_500,
  'the early direct-refund claim must yield to an overdue full-list scan before claiming old work',
);
assert.match(
  runner,
  /\['verification-required', 'login-required', 'rate-limited', 'retryable-error'\][\s\S]{0,80}\.includes\(discoveryStatus\)[\s\S]{0,360}if \(discoveryStatus !== 'retryable-error'\) return false;[\s\S]{0,2000}scenarioCodes: \['return-refund'\]/,
  'a retryable ordinary-list render error must still allow overdue refunds to be claimed',
);
assert.match(runner,
  /const ordinaryClaimsBeforeRefund = boundedSlotSession[\s\S]{0,180}\? 1[\s\S]{0,180}ORDINARY_CLAIMS_BEFORE_REFUND \|\| 3/,
  'resident workers must batch ordinary claims while bounded scheduler sessions keep one-for-one fairness');
assert.match(runner,
  /enabled_shop_count[\s\S]{0,1200}shop\.enabledShopCount \* 45_000[\s\S]{0,500}returnRefundScanStartupDelay\(\{[\s\S]{0,180}shopKey: shopId[\s\S]{0,180}slotIndex: shop\.displaySlot[\s\S]{0,180}slotCount: shop\.enabledShopCount/,
  'resident workers must deterministically stagger overdue full scans after a shared restart');
assert.match(runner,
  /const startupScanNotBefore = runnerStartedAt \+ returnRefundScanStartupDelayMs;[\s\S]{0,320}returnRefundScanRetryNotBefore = Math\.max/,
  'startup staggering must defer only the full-scan scheduler deadline');
assert.match(runner,
  /lastProcessedScenarioCode === 'return-refund'[\s\S]{0,180}ordinaryClaimsSinceRefundTurn = 0;[\s\S]{0,180}ordinaryOpportunitySinceRefundTurn = false;[\s\S]{0,260}else[\s\S]{0,180}ordinaryClaimsSinceRefundTurn \+= 1;[\s\S]{0,220}ordinaryClaimsSinceRefundTurn >= ordinaryClaimsBeforeRefund/,
  'refund claims must reset the ordinary batch and ordinary claims must reach the configured threshold before yielding');
const discoveredHeartbeatAt = runner.indexOf("await heartbeat('pdd-discovered'");
const discoveredClaimAt = runner.indexOf('claim = await claimEligibleOrdinary()', discoveredHeartbeatAt);
assert.ok(discoveredHeartbeatAt >= 0 && discoveredClaimAt > discoveredHeartbeatAt,
  'a newly discovered ordinary work order must reach the same-cycle claim path');
const discoveredContinuation = runner.slice(discoveredHeartbeatAt, discoveredClaimAt);
assert.match(discoveredContinuation, /ordinaryOpportunitySinceRefundTurn = false;/,
  'new ordinary discovery must retain ordinary priority');
assert.doesNotMatch(discoveredContinuation, /return true;/,
  'new ordinary discovery must not end the cycle before claiming the durable row');
assert.match(workflow, /ordinaryInstanceId: entry\.ordinaryInstanceId \|\| null/);
assert.match(workflow, /ordinaryInstanceId = activeOrdinaryInstanceId \|\| current\.ordinaryInstanceId \|\| null/);
assert.match(workflow, /step: releasedDeferredWaitStep\(normalizedWaitKind\),[\s\S]{0,320}platformCaseKey,/);
assert.match(workflow,
  /waitKind: error\.stage === 'pdd-consumer-negotiation-waiting'[\s\S]*'consumer-response'/,
  'consumer negotiation timers must publish a dedicated wait kind');
assert.match(incompleteWorkflowAnalysis,
  /consumer-response-waiting-released'[\s\S]*waiting-consumer-response[\s\S]*等待消费者确认拦截退款方案/u,
  'the API diagnosis must describe consumer response waits without calling them logistics waits');
assert.match(webFormat, /'consumer-response-waiting-released': '等待消费者回复'/u,
  'the frontend must label consumer response waits explicitly');
assert.match(runner, /const logisticsRelease = logisticsWaitReleaseForClaim\(progress, claim, claimHydratedAtMs\);[\s\S]*finishLogisticsWaitClaim\(claim, logisticsRelease\)/);
assert.match(runner,
  /Date\.now\(\) - claimHydratedAtMs >= workflowStallTimeoutMs[\s\S]*Date\.now\(\) - businessUpdatedAtMs >= workflowStallTimeoutMs/,
  'a newly hydrated claim must receive a full stall window before stale-runtime recovery');
assert.match(runner, /reserved\.alreadySucceeded/);
assert.doesNotMatch(runner, /findCrossShopConflict/);
assert.match(postgresAdapter, /WHERE external_order_number = \$1[\s\S]*frontend_visibility = 'operational'/);
assert.match(postgresAdapter, /work-order-discovery-reused/);
assert.doesNotMatch(postgresAdapter, /current_step = 'cross-shop-conflict'/);
assert.match(dataBackend, /SELECT pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
assert.doesNotMatch(dataBackend, /!\/verification\|required-login\|manual-login-required\//);
assert.match(dataBackend, /human-verification-required\|manual-login-required\|required-login/);
assert.match(dataBackend,
  /checkpoint\.current_step = 'manual-login-required'[\s\S]*v\.stage = 'pdd-manual-login'[\s\S]*checkpoint\.snapshot->'verificationLocation'->>'id' = v\.id::text/,
  'active verification reads must retain the current unresolved PDD manual-login challenge');
assert.doesNotMatch(postgresAdapter, /!\/verification\|required-login\|manual-login-required\//);
assert.match(globalWorkOrderUniquenessMigration, /duplicate_work_order_map/);
assert.match(globalWorkOrderUniquenessMigration, /uq_work_orders_operational_order_number/);
assert.match(globalWorkOrderUniquenessMigration, /WHERE frontend_visibility = 'operational'/);
assert.match(runner, /recoverOwnedLease: startupLeaseRecoveryPending/);
assert.match(runner,
  /const completedStartupLeaseRecoveryAttempt = startupLeaseRecoveryPending;[\s\S]{0,100}startupLeaseRecoveryPending = false/,
  'the startup lease-recovery lookup must complete even when no owned claim is returned');
assert.match(runner, /result\.code === browserDisconnectedExitCode/);
assert.match(runner, /container-restart-with-owned-lease/);
assert.match(runner, /WORKFLOW_DISCOVERY_KEEP_ALIVE/);
assert.match(runner, /WORKFLOW_RESIDENT_COMMAND_MODE/);
assert.match(runner, /WORKFLOW_ASSIGNMENT_ID/);
assert.match(runner, /startOrReusePlaywright/);
assert.match(runner, /sendWorkflowCommand/);
assert.match(workflow, /type: 'workflow-command-received'/);
assert.match(runner, /message\.type === 'workflow-command-received'[\s\S]*pending\.receivedAt[\s\S]*clearTimeout\(pending\.timer\)[\s\S]*pending\.timer = setTimeout[\s\S]*return;[\s\S]*pending\.resolve\(message\)/,
  'queue receipt must replace the delivery timeout with a bounded apply timeout without being treated as acceptance');
assert.match(runner, /residentCommandSettled[\s\S]*progress\.residentCommand\?\.requestId === requestId[\s\S]*progress\.residentCommand\?\.status === 'idle'/,
  'return-refund output must not release the next claim before the resident command is idle');
assert.match(runner, /discovery\?\.requestId === residentRequestId[\s\S]*progress\.residentCommand\?\.requestId === residentRequestId[\s\S]*progress\.residentCommand\?\.status === 'idle'/,
  'ordinary discovery must not release the next claim before its resident command is idle');
assert.match(runner, /assignmentId: claim\.leaseToken,[\s\S]*status: 'pending'/,
  'claim hydration must distinguish queued work from an accepted browser command');
assert.match(runner, /progressAssignmentId !== claim\.leaseToken/,
  'browser progress must be fenced by the current database assignment');
assert.match(workflow, /RESIDENT_COMMAND_IDENTITY_MISMATCH/);
assert.match(workflow, /assertActiveResidentCommandIdentity\('process-one-work-order'\)/);
assert.match(workflow, /assertActiveResidentCommandIdentity\(`external-effect-\$\{action\}`\)/);
assert.match(runner, /action: 'run-order'/);
assert.match(runner, /assignmentId: claim\.leaseToken/);
assert.match(runner, /activeClaim\.leaseToken !== assignmentId/);
assert.match(runner, /repository\.hasValidLease/);
assert.match(runner, /progress\.residentCommand\?\.status !== 'idle'/);
assert.match(runner, /activeLeaseLost/);
assert.match(runner, /if \(!residentBrowser\) await stopActiveChildGracefully\(\)/);
assert.match(runner, /operatorCommandGraceUntil/);
assert.match(runner, /discovery: 'operator-command-grace'/);
assert.match(runner, /residentBrowser && \(!activeChild \|\| Date\.now\(\) < operatorCommandGraceUntil\)/);
assert.match(runner, /WORKER_BROWSER_RECOVERY_ATTEMPTS/);
assert.match(runner, /createBrowserHealthMonitor/);
assert.match(runner, /WORKER_BROWSER_HEALTH_TIMEOUT_MS/);
assert.match(runner, /const browserHealthTimeoutMs = Math\.max\(\s*60_000,/);
assert.match(runner, /browserHealthFailures\.set\(child, failure\)/);
assert.match(runner, /type: 'browser-health-restart'/);
assert.match(runner, /normalizeBrowserProcessExitCode\(\{/);
assert.match(browserHealthMonitor, /windowsAbnormalTerminationCodes = new Set\(\[-1, 0xFFFFFFFF\]\)/);
assert.match(browserHealthMonitor, /platform === 'win32'/);
assert.match(runner, /recovery: 'immediate-shop-runner-restart'/);
assert.match(runner, /if \(effectiveCode === browserDisconnectedExitCode && !stopped\)/);
assert.match(
  runner,
  /if \(!completed && result\.code === 0\) \{[\s\S]*handoffActiveClaim\([\s\S]*retryOnStart: true/,
  'a clean resident workflow exit before completion must be safely handed back to the retry queue',
);
assert.doesNotMatch(runner, /result\.code === 0 \? 'paused'/);
assert.match(runner, /status: 'retry-ready',[\s\S]*currentStep: 'browser-retry-ready'/);
assert.match(runner, /Chromium context is unavailable/,
  'a missing resident Chromium context must use bounded browser recovery instead of a permanent pause');
assert.match(runner, /retryableTransientWorkflowFailure/);
assert.match(runner, /PDD_ORDER_REMARK_TEMPORARILY_UNAVAILABLE/);
assert.match(runner, /PDD_ORDINARY_FORM_TEMPORARILY_UNAVAILABLE/);
assert.match(runner, /PDD_ORDINARY_SUBMIT_RENDER_TEMPORARILY_UNAVAILABLE/);
assert.match(
  runner,
  /recoveryCommandHeartbeat = setInterval\(\(\) => heartbeat\([\s\S]*?'human-verification-required'[\s\S]*?waiting-resident-command[\s\S]*?heartbeatIntervalMs\)/,
  'a delayed verification recovery command must keep the worker heartbeat online',
);
assert.match(
  runner,
  /residentReadyHeartbeat = setInterval\(\(\) => heartbeat\([\s\S]*?'human-verification-required'[\s\S]*?waiting-resident-ready[\s\S]*?heartbeatIntervalMs\)/,
  'verification browser startup must keep the worker heartbeat online while waiting for resident readiness',
);
assert.match(
  runner,
  /finally \{\s*clearInterval\(residentReadyHeartbeat\);\s*\}/,
  'the resident-ready heartbeat must be cleared after startup settles',
);
assert.match(
  runner,
  /finally \{\s*clearInterval\(recoveryCommandHeartbeat\);\s*\}/,
  'the verification recovery heartbeat must be cleared after command settlement',
);
assert.match(runner, /OMS_QUERY_TEMPORARILY_UNAVAILABLE/);
assert.match(runner, /PDD_ORDINARY_RESULT_STAGE_TEMPORARILY_UNAVAILABLE/);
assert.match(runner, /WORKER_FAST_TRANSIENT_WORKFLOW_RETRY_MS/);
assert.match(runner, /progress\.tmsCreatedRowVisibility\?\.status === 'retry-ready'/);
assert.match(runner, /TMS_CREATED_ROW_NOT_VISIBLE/);
assert.match(runner, /progress\.systemTabs\?\.pdd\?\.url/);
assert.match(runner, /拼多多工单列表未找到订单号查询框/u);
assert.match(runner, /拼多多订单详情未在限定时间内完成渲染/u);
assert.match(runner, /拼多多普通工单详情订单号渲染刷新后等待 \\d\+ 毫秒仍未出现有效结果/u);
assert.match(runner, /拼多多普通工单详情恢复\(\?:列表\|查询\)渲染刷新后等待 \\d\+ 毫秒仍未出现有效结果/u);
assert.match(runner, /普通工单详情订单号不一致:[\s\S]*实际 未读取到/u);
assert.match(runner, /pdd-resolution-detail-loading/u);
assert.match(runner, /page\\\.\(\?:waitForURL\|goto\|reload\): Timeout/);
assert.match(runner, /\.filter-panel/u);
assert.match(runner, /progress\.tmsAttachmentTransfer\?\.status === 'failed'/);
assert.match(runner, /progress\.tmsAttachmentTransfer\?\.orderNumber === progress\.orderNumber/);
assert.match(runner, /existingEffectReservedAt: refund\.effect_reserved_at/);
assert.match(postgresAdapter, /effect\.reserved_at AS effect_reserved_at/);
assert.match(postgresAdapter, /\{reconciliationProof\}/);
assert.match(postgresAdapter, /return-refund-reconciliation-proof-effect-not-found/);
assert.match(postgresAdapter,
  /const recordExistingUnknownProof = \(verificationRequired \|\| pageError\)[\s\S]*pdd-exact-counterparty-pending-no-action-proof-waiting/,
  'automatic page-error reconciliation must persist the first exact pending proof');
assert.match(postgresAdapter,
  /const releaseExistingWaitingEffect = waitingLogistics[\s\S]*disposition === 'wait-logistics'/,
  'a stable exact counterparty wait must close its own stale refund effect');
assert.match(postgresAdapter,
  /releaseExistingWaitingEffect \? 'wait-logistics-released' : 'safe-retry-released'/,
  'wait reconciliation must remain distinguishable from a safe action retry');
assert.match(returnRefund,
  /existingEffectResolution\.disposition === 'wait-logistics'[\s\S]*decision\.outcome === 'wait-logistics'[\s\S]*return \{ \.\.\.decision, facts, existingEffectResolution \}/,
  'the mature no-action proof must become normal waiting instead of another page error');
assert.match(returnRefund,
  /readReturnRefundActivePageNumber[\s\S]*waitForReturnRefundPageTransition[\s\S]*Math\.min\(30_000/,
  'return-refund pagination must use browser page truth and a bounded 30-second render wait');
assert.match(returnRefund,
  /const listPagePreserved[\s\S]*activePage === currentPage[\s\S]*restoredSignature === pageSignature[\s\S]*restoreReturnRefundListPage\(currentPage\)/,
  'closing a refund detail must preserve or explicitly restore the current list page');
assert.match(returnRefund,
  /refreshAfterPageTransitionFailure[\s\S]*page\.reload[\s\S]*刷新后保留游标等待重试/u,
  'a stalled page transition must refresh once without advancing the persisted cursor');
assert.match(postgresAdapter, /skippedNotFound = outcome === 'skipped-not-found'/);
assert.match(postgresAdapter, /return-refund-skipped-not-found/);
assert.match(missingReturnRefundArchiveMigration, /return_refunds_action_state_check/);
assert.match(missingReturnRefundArchiveMigration, /'skipped-not-found'/);
assert.match(missingReturnRefundArchiveMigration, /completion_state = 'not-applicable'/);
assert.match(missingReturnRefundArchiveMigration, /INSERT INTO schema_migrations/);
assert.match(runner, /page\\\.waitForResponse: Timeout/);
assert.match(runner, /locator\\\.innerText: Timeout \\d\+ms exceeded/,
  'a transient PDD order-number innerText timeout must return to the bounded retry queue');
assert.match(runner, /repository\.hasUnresolvedExternalEffects/);
assert.match(runner, /!unresolvedExternalEffects[\s\S]*transientRecoveryCount/);
assert.match(postgresAdapter, /async hasUnresolvedExternalEffects/);
assert.match(workflow, /error\?\.code === 'PDD_ORDER_REMARK_TEMPORARILY_UNAVAILABLE'/);
assert.match(workflow, /isTransientPddOrderRemarkRenderFailure/);
assert.match(workflow, /if \(!remarkSaveStarted && isTransientPddOrderRemarkRenderFailure\(error\)\)/);
assert.match(workflow, /OMS_QUERY_TEMPORARILY_UNAVAILABLE/);
assert.match(workflow, /submitOmsOrderQuery\(currentInput, pass\)/);
assert.match(workflow, /currentInput = recoveredInput/);
assert.doesNotMatch(workflow, /pauseForManualReview\(targetPage, 'oms-order-query'/);
assert.match(workflow,
  /const pauseForTransientRetry = async[\s\S]*step: 'flow-paused'[\s\S]*retryAfterMs: 30_000[\s\S]*manualReview: null/,
  'read-only render/query failures must release the claim without creating a manual-review notification');
for (const transientCode of [
  'OMS_WAREHOUSE_TEMPORARILY_UNAVAILABLE',
  'OMS_ORDER_STATUS_TEMPORARILY_UNAVAILABLE',
  'OMS_ANALYSIS_TEMPORARILY_UNAVAILABLE',
  'PDD_LOGISTICS_ANALYSIS_TEMPORARILY_UNAVAILABLE',
  'PDD_DETAIL_TEMPORARILY_UNAVAILABLE',
  'PDD_ORDER_IDENTITY_TEMPORARILY_UNAVAILABLE',
]) {
  assert.match(workflow, new RegExp(transientCode), `${transientCode} must be emitted by the workflow`);
  assert.match(runner, new RegExp(transientCode.replace(/_(?:WAREHOUSE|ORDER_STATUS|ANALYSIS|LOGISTICS_ANALYSIS|DETAIL|ORDER_IDENTITY)_/, '_.*')),
    `${transientCode} must be recognized by the worker retry policy`);
}
assert.doesNotMatch(workflow,
  /pauseForManualReview\(targetPage, 'tms-input-validation', '(?:拼多多物流时间线或阶段分析不完整|OMS 发货仓库或低值品结果不完整)'/,
  'incomplete pre-submit TMS inputs must use bounded transient recovery');
assert.match(runner,
  /progress\.transientWorkflowFailure\?\.retryAfterMs[\s\S]*Number\.isFinite\(requestedRetryMs\)/,
  'the worker must honor the bounded retry delay requested by a transient workflow failure');
assert.match(runner, /status: 'retry-ready',[\s\S]*currentStep: 'transient-workflow-retry-ready'/);
assert.match(
  runner,
  /retryableTransientWorkflowFailure[\s\S]*locator\\\.innerText: Timeout \\d\+ms exceeded[\s\S]*waiting for locator/,
  'a read-only body render timeout must enter bounded automatic retry instead of manual review',
);
const transientWorkflowClassifier = runner.slice(
  runner.indexOf('const retryableTransientWorkflowFailure ='),
  runner.indexOf('async function reconcileCompletedDatabaseOrder'),
);
assert.match(
  transientWorkflowClassifier,
  /\[currentUrl, pddUrl\][\s\S]*page\\\.\(\?:waitForURL\|goto\|reload\): Timeout/,
  'PDD page.reload timeouts must retry only inside the PDD URL-scoped classifier',
);
assert.match(runner,
  /fastTransientFailure[\s\S]*page\\\.\(\?:waitForURL\|goto\|reload\): Timeout \\d\+ms exceeded[\s\S]*fastTransientWorkflowRetryMs/,
  'PDD-scoped navigation timeouts must use the 30-second fast retry path');
const analyzeOmsOrderStart = workflow.indexOf('const analyzeOmsOrderUnlocked = async');
const abnormalOmsShortcut = workflow.indexOf(
  "if (scenarioCode === 'abnormal-network-warning' && !abnormalNetworkRequiresWarehouse) {",
  analyzeOmsOrderStart,
);
const abnormalOmsMarkerBypass = workflow.indexOf(
  "if (scenarioCode !== 'abnormal-network-warning') {",
  abnormalOmsShortcut,
);
const omsMarkerLookup = workflow.indexOf(
  'const markAnalysis = await readOmsOrderMark',
  analyzeOmsOrderStart,
);
assert.ok(analyzeOmsOrderStart >= 0
  && abnormalOmsShortcut > analyzeOmsOrderStart
  && abnormalOmsMarkerBypass > abnormalOmsShortcut
  && omsMarkerLookup > abnormalOmsMarkerBypass,
'abnormal-network OMS analysis must require warehouse only for allocation and never require the unrelated marker cell');
assert.match(workflow,
  /OMS标记: '异常网点不适用'/u);
assert.match(transientPageRecoveryMigration, /transient-page-pause-recovered/);
assert.match(transientPageRecoveryMigration, /status IN \('reserved', 'unknown'\)/);
assert.match(transientPageRecoveryMigration, /effect\.effect_type = 'pdd-submit'/);
assert.match(pddNavigationTimeoutRecoveryMigration, /pdd-navigation-timeout-pause-recovered/);
assert.match(pddNavigationTimeoutRecoveryMigration, /page\\\.\(waitForURL\|goto\): Timeout/);
assert.match(pddNavigationTimeoutRecoveryMigration, /status IN \('reserved', 'unknown'\)/);
assert.match(pddNavigationTimeoutRecoveryMigration, /effect\.effect_type = 'pdd-submit'/);
assert.match(ordinaryDetailRenderTimeoutRecoveryMigration, /ordinary-detail-render-timeout-recovered/);
assert.match(ordinaryDetailRenderTimeoutRecoveryMigration, /拼多多普通工单详情订单号渲染刷新后等待 \[0-9\]\+/u);
assert.match(ordinaryDetailRenderTimeoutRecoveryMigration, /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(ordinaryDetailRenderTimeoutRecoveryMigration, /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('succeeded', 'unknown'\)/);
assert.match(ordinaryDetailRenderTimeoutRecoveryMigration, /runtime\.lease_expires_at > now\(\)/);
assert.match(ordinaryDetailRenderTimeoutRecoveryMigration, /UPDATE ordinary_work_order_instances/);
assert.match(ordinaryDetailRenderTimeoutRecoveryMigration, /UPDATE notification_outbox/);
assert.match(ordinaryDetailRenderTimeoutRecoveryMigration, /INSERT INTO schema_migrations/);
assert.match(shortDeliveryAddressFieldLocatorRecoveryMigration,
  /ordinary-delivery-field-locator-failure-recovered/);
assert.match(shortDeliveryAddressFieldLocatorRecoveryMigration,
  /ordinaryPddFieldRecovery,valueLength[\s\S]*BETWEEN 1 AND 100/);
assert.match(shortDeliveryAddressFieldLocatorRecoveryMigration,
  /clickAttempted'[\s\S]*false[\s\S]*exactPendingEditableDetail/);
assert.match(shortDeliveryAddressFieldLocatorRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(shortDeliveryAddressFieldLocatorRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status = 'succeeded'/);
assert.match(shortDeliveryAddressFieldLocatorRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(shortDeliveryAddressFieldLocatorRecoveryMigration,
  /UPDATE ordinary_work_order_instances/);
assert.match(shortDeliveryAddressFieldLocatorRecoveryMigration,
  /INSERT INTO schema_migrations/);
assert.match(deliveryFieldFallbackBudgetMigration,
  /ordinary-delivery-field-fallback-budget-reset/);
assert.match(deliveryFieldFallbackBudgetMigration,
  /ordinaryDeliveryFieldLocatorRecovery202,status/);
assert.match(deliveryFieldFallbackBudgetMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(deliveryFieldFallbackBudgetMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status = 'succeeded'/);
assert.match(deliveryFieldFallbackBudgetMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(deliveryFieldFallbackBudgetMigration,
  /UPDATE ordinary_work_order_instances/);
assert.match(deliveryFieldFallbackBudgetMigration,
  /INSERT INTO schema_migrations/);
assert.match(ordinaryDetailOrderNumberReadRecoveryMigration,
  /ordinary-detail-order-number-read-pause-recovered/);
assert.match(ordinaryDetailOrderNumberReadRecoveryMigration,
  /普通工单详情订单号不一致:[\s\S]*实际 未读取到/u);
assert.match(ordinaryDetailOrderNumberReadRecoveryMigration,
  /binding\.binding_token::text[\s\S]*latestDiscovery,pddIdentityBindingToken/);
assert.match(ordinaryDetailOrderNumberReadRecoveryMigration, /binding\.mall_id = coalesce/);
assert.match(ordinaryDetailOrderNumberReadRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(ordinaryDetailOrderNumberReadRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('succeeded', 'unknown'\)/);
assert.match(ordinaryDetailOrderNumberReadRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(ordinaryDetailOrderNumberReadRecoveryMigration,
  /UPDATE ordinary_work_order_instances/);
assert.match(ordinaryDetailOrderNumberReadRecoveryMigration, /UPDATE notification_outbox/);
assert.match(ordinaryDetailOrderNumberReadRecoveryMigration, /INSERT INTO schema_migrations/);
assert.match(workflow,
  /const ensureOmsScenarioPreparation[\s\S]*allowFirstAvailableCarrier: true/u);
assert.match(workflow,
  /carrierSelectionStrategy: 'no-platform-recommendation-visible'/);
assert.match(workflow,
  /平台未展示建议快递，订单已按现有快递发出且物流正常/u);
assert.match(abnormalNetworkAllocatedWithoutRecommendationRecoveryMigration,
  /abnormal-network-allocated-without-recommendation-recovered/);
assert.match(abnormalNetworkAllocatedWithoutRecommendationRecoveryMigration,
  /omsAnalysis,orderStatus[\s\S]*已配货[\s\S]*已发货[\s\S]*已完成/u);
assert.match(abnormalNetworkAllocatedWithoutRecommendationRecoveryMigration,
  /binding\.binding_token::text[\s\S]*latestDiscovery,pddIdentityBindingToken/);
assert.match(abnormalNetworkAllocatedWithoutRecommendationRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(abnormalNetworkAllocatedWithoutRecommendationRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('succeeded', 'unknown'\)/);
assert.match(abnormalNetworkAllocatedWithoutRecommendationRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(abnormalNetworkAllocatedWithoutRecommendationRecoveryMigration,
  /UPDATE ordinary_work_order_instances/);
assert.match(abnormalNetworkAllocatedWithoutRecommendationRecoveryMigration,
  /UPDATE notification_outbox/);
assert.match(abnormalNetworkAllocatedWithoutRecommendationRecoveryMigration,
  /INSERT INTO schema_migrations/);
assert.match(deliveryRiskStagedFormRecoveryMigration,
  /delivery-risk-staged-form-pause-recovered/);
assert.match(deliveryRiskStagedFormRecoveryMigration,
  /ordinaryPddOptionLookupFailure,frames[\s\S]*需要联系物流核实/u);
assert.match(deliveryRiskStagedFormRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(deliveryRiskStagedFormRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('succeeded', 'unknown'\)/);
assert.match(deliveryRiskStagedFormRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(deliveryRiskStagedFormRecoveryMigration,
  /UPDATE ordinary_work_order_instances/);
assert.match(deliveryRiskStagedFormRecoveryMigration,
  /UPDATE notification_outbox/);
assert.match(deliveryRiskStagedFormRecoveryMigration,
  /INSERT INTO schema_migrations/);
assert.match(directSubjectiveRefundRecoveryMigration,
  /direct-subjective-refund-pause-recovered/);
assert.match(directSubjectiveRefundRecoveryMigration,
  /scenario_code = 'in-transit-refund'/);
assert.doesNotMatch(directSubjectiveRefundRecoveryMigration,
  /scenario_code = 'intercept-recall'/);
assert.match(directSubjectiveRefundRecoveryMigration,
  /pddResolutionSubmission,lastClickAttemptedAt/);
assert.match(directSubjectiveRefundRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(directSubjectiveRefundRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'/);
assert.match(directSubjectiveRefundRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(directSubjectiveRefundRecoveryMigration,
  /同意消费者退款申请/u);
assert.match(directSubjectiveRefundRecoveryMigration,
  /UPDATE ordinary_work_order_instances/);
assert.match(directSubjectiveRefundRecoveryMigration,
  /UPDATE notification_outbox/);
assert.match(directSubjectiveRefundRecoveryMigration,
  /INSERT INTO schema_migrations/);
assert.match(deliveryRiskConfirmButtonRecoveryMigration,
  /scenario_code = 'delivery-risk-concern'/);
assert.match(deliveryRiskConfirmButtonRecoveryMigration,
  /submit_effect\.status = 'failed'[\s\S]*submit-button-not-rendered[\s\S]*clickAttempted' = 'false'/,
  'delivery-risk confirm-button recovery must require proof that no submit click occurred');
assert.match(deliveryRiskConfirmButtonRecoveryMigration,
  /status IN \('reserved', 'unknown'\)[\s\S]*effect_type = 'pdd-submit'[\s\S]*status = 'succeeded'/,
  'delivery-risk confirm-button recovery must exclude unresolved or already successful submissions');
assert.match(deliveryRiskConfirmButtonRecoveryMigration,
  /accept-form-scoped-confirm-button[\s\S]*preserveSucceededEffects', true/);
assert.match(deliveryRiskConfirmButtonRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)[\s\S]*UPDATE ordinary_work_order_instances[\s\S]*UPDATE notification_outbox/);
assert.match(tmsAttachmentResponseTimeoutRecoveryMigration, /tms-attachment-response-timeout-pause-recovered/);
assert.match(tmsAttachmentResponseTimeoutRecoveryMigration, /tmsAttachmentTransfer,status/);
assert.match(tmsAttachmentResponseTimeoutRecoveryMigration, /effect\.effect_type = 'tms-create'/);
assert.match(tmsAttachmentResponseTimeoutRecoveryMigration, /effect\.status IN \('succeeded', 'unknown'\)/);
assert.match(tmsAttachmentResponseTimeoutRecoveryMigration, /runtime\.lease_expires_at > now\(\)/);
assert.match(tmsStandardizedEvidenceRecoveryMigration, /tms-standardized-evidence-pause-recovered/);
assert.match(tmsStandardizedEvidenceRecoveryMigration, /tms\.external_ticket_id = work_order\.payload#>>'\{tmsWorkOrder,ticketId\}'/);
assert.match(tmsStandardizedEvidenceRecoveryMigration, /count\(DISTINCT \(tms\.external_ticket_id, tms\.payload->>'ticketNo'\)\)/);
assert.match(tmsStandardizedEvidenceRecoveryMigration, /status IN \('reserved', 'unknown'\)/);
assert.match(tmsStandardizedEvidenceRecoveryMigration, /effect\.effect_type = 'pdd-submit'/);
assert.match(deliveryRiskFinalResultRecoveryMigration, /delivery-risk-final-result-pause-recovered/);
assert.match(deliveryRiskFinalResultRecoveryMigration, /请您确认最终履约结果/u);
assert.match(deliveryRiskFinalResultRecoveryMigration, /status IN \('reserved', 'unknown'\)/);
assert.match(deliveryRiskFinalResultRecoveryMigration, /effect\.effect_type = 'pdd-submit'/);
assert.match(semanticPddOptionRecoveryMigration, /pdd-option-semantic-pause-recovered/);
assert.match(semanticPddOptionRecoveryMigration, /已进行召回\|消费者已收到货\|未收到退货商品/);
assert.match(semanticPddOptionRecoveryMigration, /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(semanticPddOptionRecoveryMigration, /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('succeeded', 'unknown'\)/);
assert.match(returnedGoodsOptionAliasRecoveryMigration,
  /pdd-returned-goods-option-alias-pause-recovered/);
assert.match(returnedGoodsOptionAliasRecoveryMigration,
  /scenario_code = 'proactive-logistics-service'/);
assert.match(returnedGoodsOptionAliasRecoveryMigration, /未收到退回的商品/u);
assert.match(returnedGoodsOptionAliasRecoveryMigration,
  /binding\.binding_token::text[\s\S]*latestDiscovery,pddIdentityBindingToken/);
assert.match(returnedGoodsOptionAliasRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(returnedGoodsOptionAliasRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('succeeded', 'unknown'\)/);
assert.match(returnedGoodsOptionAliasRecoveryMigration, /runtime\.lease_expires_at > now\(\)/);
assert.match(returnedGoodsOptionAliasRecoveryMigration, /UPDATE ordinary_work_order_instances/);
assert.match(returnedGoodsOptionAliasRecoveryMigration, /UPDATE notification_outbox/);
assert.match(returnedGoodsOptionAliasRecoveryMigration, /INSERT INTO schema_migrations/);
assert.match(proactiveTwoLevelFormRecoveryMigration,
  /pdd-proactive-two-level-form-pause-recovered/);
assert.match(proactiveTwoLevelFormRecoveryMigration,
  /ordinaryScenarioDecision,reasonCode[\s\S]*return-logistics-not-found-within-48-hours/);
assert.match(proactiveTwoLevelFormRecoveryMigration,
  /ordinaryPddOptionLookupFailure,frames[\s\S]*未收到退回的商品[\s\S]*未查到退货物流轨迹/u);
assert.match(proactiveTwoLevelFormRecoveryMigration,
  /binding\.binding_token::text[\s\S]*latestDiscovery,pddIdentityBindingToken/);
assert.match(proactiveTwoLevelFormRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(proactiveTwoLevelFormRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('succeeded', 'unknown'\)/);
assert.match(proactiveTwoLevelFormRecoveryMigration, /runtime\.lease_expires_at > now\(\)/);
assert.match(proactiveTwoLevelFormRecoveryMigration, /UPDATE ordinary_work_order_instances/);
assert.match(proactiveTwoLevelFormRecoveryMigration, /UPDATE notification_outbox/);
assert.match(proactiveTwoLevelFormRecoveryMigration, /INSERT INTO schema_migrations/);
assert.match(absentProactiveEvidenceControlRecoveryMigration,
  /pdd-proactive-absent-evidence-control-pause-recovered/);
assert.match(absentProactiveEvidenceControlRecoveryMigration,
  /ordinaryEvidenceUpload,diagnostics,fileInputs[\s\S]*= '\[\]'::jsonb/);
assert.match(absentProactiveEvidenceControlRecoveryMigration,
  /effect\.effect_type = 'evidence-upload'[\s\S]*effect\.status = 'failed'/);
assert.match(absentProactiveEvidenceControlRecoveryMigration,
  /pddEvidenceUploadFailed', false/);
assert.match(absentProactiveEvidenceControlRecoveryMigration,
  /pdd-return-logistics-screenshot[\s\S]*required[\s\S]*false/);
assert.match(absentProactiveEvidenceControlRecoveryMigration,
  /binding\.binding_token::text[\s\S]*latestDiscovery,pddIdentityBindingToken/);
assert.match(absentProactiveEvidenceControlRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(absentProactiveEvidenceControlRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('succeeded', 'unknown'\)/);
assert.match(absentProactiveEvidenceControlRecoveryMigration, /runtime\.lease_expires_at > now\(\)/);
assert.match(absentProactiveEvidenceControlRecoveryMigration, /UPDATE ordinary_work_order_instances/);
assert.match(absentProactiveEvidenceControlRecoveryMigration, /UPDATE notification_outbox/);
assert.match(absentProactiveEvidenceControlRecoveryMigration, /INSERT INTO schema_migrations/);
assert.match(transientSubjectiveStateChangeRecoveryMigration,
  /subjective-state-change-rejection-recovered/);
assert.match(transientSubjectiveStateChangeRecoveryMigration,
  /pddResolutionFlow,flowCode[\s\S]*subjective-intercept/);
assert.match(transientSubjectiveStateChangeRecoveryMigration,
  /pddResolutionSubmission,lastClickAttemptedAt[\s\S]*IS NULL/);
assert.match(transientSubjectiveStateChangeRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'/);
assert.match(transientSubjectiveStateChangeRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(transientSubjectiveStateChangeRecoveryMigration, /runtime\.lease_expires_at > now\(\)/);
assert.match(transientSubjectiveStateChangeRecoveryMigration, /UPDATE ordinary_work_order_instances/);
assert.match(transientSubjectiveStateChangeRecoveryMigration, /UPDATE notification_outbox/);
assert.match(transientSubjectiveStateChangeRecoveryMigration, /INSERT INTO schema_migrations/);
assert.match(definitivePddStateChangeRecoveryMigration,
  /definitive-pdd-state-change-rejection-recovered/);
assert.match(definitivePddStateChangeRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status = 'failed'/);
assert.match(definitivePddStateChangeRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(definitivePddStateChangeRecoveryMigration, /runtime\.lease_expires_at > now\(\)/);
assert.match(definitivePddStateChangeRecoveryMigration, /UPDATE ordinary_work_order_instances/);
assert.match(definitivePddStateChangeRecoveryMigration, /UPDATE notification_outbox/);
assert.match(postDependencyVerificationRecoveryMigration,
  /ordinary-post-dependency-verification-pause-recovered/);
assert.match(postDependencyVerificationRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status = 'succeeded'/);
assert.match(postDependencyVerificationRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(postDependencyVerificationRecoveryMigration,
  /latest_success_at[\s\S]*human-verification-required/);
assert.match(postDependencyVerificationRecoveryMigration, /runtime\.lease_expires_at > now\(\)/);
assert.match(postDependencyVerificationRecoveryMigration, /UPDATE ordinary_work_order_instances/);
assert.match(postDependencyVerificationRecoveryMigration, /UPDATE notification_outbox/);
assert.match(completedInterceptLowValueRefundRecoveryMigration,
  /completed-intercept-low-value-refund-recovered/);
assert.match(completedInterceptLowValueRefundRecoveryMigration,
  /candidateCount}' = '1'/);
assert.match(completedInterceptLowValueRefundRecoveryMigration,
  /identity,values,任务状态}' = '已完成'/);
assert.match(completedInterceptLowValueRefundRecoveryMigration,
  /identity,values,快递回复结果}' = '已拦截'/);
assert.match(completedInterceptLowValueRefundRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)[\s\S]*effect\.effect_type = 'pdd-submit'/);
assert.match(completedInterceptLowValueRefundRecoveryMigration, /runtime\.lease_expires_at > now\(\)/);
assert.match(completedInterceptLowValueRefundRecoveryMigration, /UPDATE ordinary_work_order_instances/);
assert.match(completedInterceptLowValueRefundRecoveryMigration, /UPDATE notification_outbox/);
assert.match(completedInterceptLowValueRefundRecoveryMigration, /INSERT INTO schema_migrations/);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /deterministic-ordinary-pause-recovered/);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /发货物流不足以判断消费者是否已签收/u);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /OMS 当前订单行未找到“标记”单元格/u);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /异常网点预警未找到平台建议快递/u);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /OMS 发货快递没有平台建议选项/u);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /拼多多发货城市范围判断缺失/u);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /拼多多未找到必选处理结果: 已同意退货退款/u);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /locator\[\.\]innerText: Timeout \[0-9\]\+ms exceeded/);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /Chromium context is unavailable before creating a background tab/);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /completed-without-evidence-artifacts[\s\S]*archive-confirmed-completion-without-artifacts/);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /拼多多未找到“发货物流”标签，已停止读取物流/u);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /verification-focus\[\.\]lock/);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /mms-header__open-item[\s\S]*TEMU[\s\S]*网格仓\/服务站招募/u);
assert.ok(
  deterministicOrdinaryPauseRecoveryMigration.indexOf("THEN 'browser-context-unavailable'")
    < deterministicOrdinaryPauseRecoveryMigration.indexOf("THEN 'abnormal-network-carrier-fallback'"),
  'specific browser failures must be classified before the general abnormal-network fallback',
);
assert.match(
  deterministicOrdinaryPauseRecoveryMigration,
  /work_order\.scenario_code = 'intercept-recall'[\s\S]{0,260}发货物流不足以判断消费者是否已签收[\s\S]{0,80}THEN 'intercept-unknown-sign-status'/u,
  'the intercept fallback class must not swallow unrelated render failures from the same scenario',
);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /omsWarehouseParse,rawShippingText[\s\S]*推荐仓库/);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /tmsDuplicateCheck,candidateCount[\s\S]*tmsDuplicateCheck,decisionComparison,matches/);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /tmsDuplicateCheck,identity,values,运单号[\s\S]*责任快递[\s\S]*发货仓库/u);
assert.match(workflow,
  /const tabWaitMs = Math\.max\(1_000, Math\.min\(30_000, pddRenderWaitMs\)\)[\s\S]*const waitForTab[\s\S]*targetPage\.reload[\s\S]*attempt = await openOnce\(\)/u,
  'PDD logistics tabs must wait up to 30 seconds and refresh once before failing');
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /binding\.binding_token::text[\s\S]*latestDiscovery,pddIdentityBindingToken/);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /pddShopIdentity,mallId[\s\S]*IS NULL[\s\S]*OR binding\.mall_id = coalesce/);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('succeeded', 'unknown'\)/);
assert.match(deterministicOrdinaryPauseRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(deterministicOrdinaryPauseRecoveryMigration, /UPDATE ordinary_work_order_instances/);
assert.match(deterministicOrdinaryPauseRecoveryMigration, /UPDATE notification_outbox/);
assert.match(deterministicOrdinaryPauseRecoveryMigration, /INSERT INTO schema_migrations/);
assert.match(ownerDeletedReturnRefundIdentityRecoveryMigration,
  /recovery_reason = 'owner-deleted'/);
assert.match(ownerDeletedReturnRefundIdentityRecoveryMigration,
  /refund\.action_state IN \([\s\S]*'waiting-logistics'[\s\S]*'verification-required'[\s\S]*'page-error'/);
assert.match(ownerDeletedReturnRefundIdentityRecoveryMigration,
  /observed\.observed_mall_id[\s\S]*target\.mall_id[\s\S]*observed\.observed_shop_name[\s\S]*target\.actual_shop_name/);
assert.match(ownerDeletedReturnRefundIdentityRecoveryMigration,
  /other_binding\.shop_id <> target\.shop_id/,
  'an exact-name owner recovery must require one unique current binding');
assert.match(ownerDeletedReturnRefundIdentityRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)[\s\S]*effect\.effect_type = 'pdd-return-refund'[\s\S]*effect\.status = 'succeeded'/,
  'uncertain and already-succeeded refund effects must remain held');
assert.match(ownerDeletedReturnRefundIdentityRecoveryMigration,
  /other_refund\.aftersale_number = refund\.aftersale_number[\s\S]*other_work_order\.shop_id = target\.shop_id/,
  'any duplicate aftersale at the target shop must block relocation');
assert.match(ownerDeletedReturnRefundIdentityRecoveryMigration,
  /cleared_stale_runtime[\s\S]*current_work_order_id = NULL[\s\S]*lease_expires_at <= now\(\)/);
assert.doesNotMatch(ownerDeletedReturnRefundIdentityRecoveryMigration,
  /UPDATE workflow_checkpoints[\s\S]*SET shop_id/,
  'a per-shop workflow checkpoint must never be moved onto an existing target primary key');
assert.match(ownerDeletedReturnRefundIdentityRecoveryMigration,
  /schedule_state = 'queued'[\s\S]*next_refund_scan_at = least/);
assert.match(ownerDeletedReturnRefundIdentityRecoveryMigration,
  /INSERT INTO schema_migrations/);
assert.match(terminalAndTransientOrdinaryPauseRecoveryMigration,
  /ordinary-terminal-or-transient-pause-recovered/);
assert.match(terminalAndTransientOrdinaryPauseRecoveryMigration,
  /locator\\\.innerText:[\s\S]*订单编号|订单号/u);
assert.match(terminalAndTransientOrdinaryPauseRecoveryMigration,
  /拼多多普通工单详情订单号渲染刷新后等待/u);
assert.match(terminalAndTransientOrdinaryPauseRecoveryMigration,
  /拼多多登录后仍返回登录页/u);
assert.match(terminalAndTransientOrdinaryPauseRecoveryMigration,
  /pdd-resolution-outcome-mismatch/);
assert.match(terminalAndTransientOrdinaryPauseRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(terminalAndTransientOrdinaryPauseRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(terminalAndTransientOrdinaryPauseRecoveryMigration,
  /UPDATE ordinary_work_order_instances/);
assert.match(terminalAndTransientOrdinaryPauseRecoveryMigration,
  /UPDATE notification_outbox/);
assert.match(terminalAndTransientOrdinaryPauseRecoveryMigration,
  /175_recover_terminal_and_transient_ordinary_pauses\.sql/);
assert.match(ordinarySubmitRenderRecoveryMigration,
  /ordinary-submit-render-pause-recovered/);
assert.match(ordinarySubmitRenderRecoveryMigration,
  /拼多多.*提交按钮等待.*仍未渲染/u);
assert.match(ordinarySubmitRenderRecoveryMigration,
  /lastClickAttemptedAt/);
assert.match(ordinarySubmitRenderRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown', 'succeeded'\)/);
assert.match(ordinarySubmitRenderRecoveryMigration,
  /receipt->>'clickAttempted'/);
assert.match(ordinarySubmitRenderRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(ordinarySubmitRenderRecoveryMigration,
  /UPDATE ordinary_work_order_instances/);
assert.match(ordinarySubmitRenderRecoveryMigration,
  /UPDATE notification_outbox/);
assert.match(ordinarySubmitRenderRecoveryMigration,
  /176_recover_ordinary_submit_render_pauses\.sql/);
assert.match(workflow,
  /PDD_ORDINARY_SUBMIT_RENDER_TEMPORARILY_UNAVAILABLE/);
assert.match(workflow,
  /ordinary-submit-render-retry-ready/);
assert.doesNotMatch(workflow,
  /ordinary-submit-render-recovery-exhausted/,
  'a submit button that never rendered must enter bounded automatic retry instead of permanent manual review');
assert.match(workflow, /recordAcceptedPddTerminalOutcomeMismatch/);
assert.match(workflow, /terminal-order-match-is-authoritative/);
assert.doesNotMatch(workflow,
  /pauseForManualReview\([\s\S]{0,240}'pdd-resolution-outcome-mismatch'/,
  'a matching completed PDD order must be archived instead of transferred to manual review');
assert.match(workflow, /unknown-treated-as-within-origin-city/u);
assert.match(workflow, /pddEquivalentDirectRefundOutcomeGroup/u);
assert.match(workflow, /hasVisiblePddDirectRefundOutcome/u);
assert.match(workflow, /同意消费者退款申请/u);
assert.match(directRefundOptionAliasRecoveryMigration,
  /pddResolutionDecision'->>'flowCode' = 'primary-refund'/);
assert.match(directRefundOptionAliasRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('reserved', 'unknown', 'succeeded'\)/);
assert.match(directRefundOptionAliasRecoveryMigration,
  /lastClickAttemptedAt/);
assert.match(directRefundOptionAliasRecoveryMigration,
  /177_recover_direct_refund_option_alias_pauses\.sql/);
assert.match(deliveredAddressNoClickRecoveryMigration,
  /260819-138590349682279/);
assert.match(deliveredAddressNoClickRecoveryMigration,
  /拼多多“\/送达地址\/”填写后未保持内容/u);
assert.match(deliveredAddressNoClickRecoveryMigration,
  /effect\.status = 'unknown'[\s\S]*jsonb_typeof\(effect\.receipt\) = 'null'/);
assert.match(deliveredAddressNoClickRecoveryMigration,
  /CASE[\s\S]*jsonb_typeof\(effect\.receipt\) = 'null'[\s\S]*THEN '\{\}'::jsonb/);
assert.match(deliveredAddressNoClickRecoveryMigration,
  /audit\.payload->>'state' = 'not-applied'[\s\S]*confirmedNotApplied/);
assert.match(deliveredAddressNoClickRecoveryMigration,
  /'clickAttempted', false/);
assert.match(deliveredAddressNoClickRecoveryMigration,
  /'submitAttemptCount', 0/);
assert.match(deliveredAddressNoClickRecoveryMigration,
  /other_effect\.status IN \('reserved', 'unknown', 'succeeded'\)/);
assert.match(deliveredAddressNoClickRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(deliveredAddressNoClickRecoveryMigration,
  /UPDATE ordinary_work_order_instances/);
assert.match(deliveredAddressNoClickRecoveryMigration,
  /UPDATE notification_outbox/);
assert.match(deliveredAddressNoClickRecoveryMigration,
  /178_recover_delivered_address_no_click_submit\.sql/);
assert.match(legacyUnclickedSecondAttemptRecoveryMigration,
  /260812-150177062531564/);
assert.match(legacyUnclickedSecondAttemptRecoveryMigration,
  /260819-168485230092969/);
assert.match(legacyUnclickedSecondAttemptRecoveryMigration,
  /lastClickAttemptedAt[\s\S]*< effect\.reserved_at/);
assert.match(legacyUnclickedSecondAttemptRecoveryMigration,
  /audit\.payload->>'state' = 'not-applied'/);
assert.match(legacyUnclickedSecondAttemptRecoveryMigration,
  /2 <= \([\s\S]*count\(\*\)[\s\S]*confirmedNotApplied/);
assert.match(legacyUnclickedSecondAttemptRecoveryMigration,
  /other_effect\.status IN \('reserved', 'unknown', 'succeeded'\)/);
assert.match(legacyUnclickedSecondAttemptRecoveryMigration,
  /'clickAttempted', false/);
assert.match(legacyUnclickedSecondAttemptRecoveryMigration,
  /'submitAttemptCount', 1/);
assert.match(legacyUnclickedSecondAttemptRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(legacyUnclickedSecondAttemptRecoveryMigration,
  /UPDATE ordinary_work_order_instances/);
assert.match(legacyUnclickedSecondAttemptRecoveryMigration,
  /179_recover_legacy_unclicked_second_submit_attempts\.sql/);
assert.match(lateUnclickedRecallOptionRecoveryMigration,
  /260812-465662133910366/);
assert.match(lateUnclickedRecallOptionRecoveryMigration,
  /pdd-work-order:500013005095448/);
assert.match(lateUnclickedRecallOptionRecoveryMigration,
  /拼多多未找到场景选项（已等待 30 秒）: 已进行召回 \/ 已召回 \/ 已完成召回 \/ 已拦截成功/u);
assert.match(lateUnclickedRecallOptionRecoveryMigration,
  /lastClickAttemptedAt[\s\S]*IS NULL/);
assert.match(lateUnclickedRecallOptionRecoveryMigration,
  /2 <= \([\s\S]*count\(\*\)[\s\S]*present-in-pending-list/);
assert.match(lateUnclickedRecallOptionRecoveryMigration,
  /audit\.payload->>'state' = 'not-applied'/);
assert.match(lateUnclickedRecallOptionRecoveryMigration,
  /other_effect\.status IN \('reserved', 'unknown', 'succeeded'\)/);
assert.match(lateUnclickedRecallOptionRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(lateUnclickedRecallOptionRecoveryMigration,
  /intervention\.status = 'resolved'[\s\S]*nullif\(intervention\.resolved_by, ''\) IS NULL[\s\S]*intervention\.resolved_at < intervention\.created_at/,
  'migration 187 may recover only a system-resolved intervention with an impossible timestamp');
assert.match(lateUnclickedRecallOptionRecoveryMigration,
  /WHEN intervention\.resolved_at < intervention\.created_at THEN now\(\)/,
  'migration 187 must normalize the impossible resolution timestamp after recovery');
assert.match(lateUnclickedRecallOptionRecoveryMigration,
  /'clickAttempted', false/);
assert.match(lateUnclickedRecallOptionRecoveryMigration,
  /'submitAttemptCount', 0/);
assert.match(lateUnclickedRecallOptionRecoveryMigration,
  /UPDATE ordinary_work_order_instances/);
assert.match(lateUnclickedRecallOptionRecoveryMigration,
  /UPDATE notification_outbox/);
assert.match(lateUnclickedRecallOptionRecoveryMigration,
  /187_recover_late_unclicked_recall_option\.sql/);
const manualInterventionResolutionSource = apiDataBackend.slice(
  apiDataBackend.indexOf("if (workOrderId && eventHasSafeInstanceBinding && runtimeStatus === 'completed')"),
  apiDataBackend.indexOf('if (eventHasSafeInstanceBinding\n          && raw.reasonCode'),
);
assert.equal(
  (manualInterventionResolutionSource.match(/created_at <= \$[23]::timestamptz/gu) || []).length,
  3,
  'every event-driven intervention resolution must reject events older than the intervention',
);
assert.match(counterpartyPendingReturnRefundRecoveryMigration,
  /待买家\(处理\|处理中\|寄出退货\|发货\)/u);
assert.match(counterpartyPendingReturnRefundRecoveryMigration,
  /待消费者\(处理\|寄出退货\|寄货\)/u);
assert.match(counterpartyPendingReturnRefundRecoveryMigration,
  /refund\.action_button_visible IS DISTINCT FROM true/);
assert.match(counterpartyPendingReturnRefundRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown', 'succeeded'\)/);
assert.match(counterpartyPendingReturnRefundRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(counterpartyPendingReturnRefundRecoveryMigration,
  /action_state = 'waiting-logistics'/);
assert.match(counterpartyPendingReturnRefundRecoveryMigration,
  /next_check_at = now\(\) \+ interval '4 hours'/);
assert.match(counterpartyPendingReturnRefundRecoveryMigration,
  /UPDATE notification_outbox/);
assert.match(counterpartyPendingReturnRefundRecoveryMigration,
  /INSERT INTO workflow_events/);
assert.match(counterpartyPendingReturnRefundRecoveryMigration,
  /188_recover_counterparty_pending_return_refund_page_errors\.sql/);
assert.match(preSubmitVerificationRecoveryMigration,
  /阶段: expand-all-logistics\(-action-error\)\?/u);
assert.match(preSubmitVerificationRecoveryMigration,
  /pddResolutionSubmission,lastClickAttemptedAt[\s\S]*IS NULL/);
assert.match(preSubmitVerificationRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown', 'succeeded'\)/);
assert.match(preSubmitVerificationRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(preSubmitVerificationRecoveryMigration,
  /UPDATE ordinary_work_order_instances/);
assert.match(preSubmitVerificationRecoveryMigration,
  /UPDATE notification_outbox/);
assert.doesNotMatch(preSubmitVerificationRecoveryMigration,
  /阶段: pdd-resolution-submit/u);
assert.match(preSubmitVerificationRecoveryMigration,
  /189_recover_pre_submit_verification_pauses\.sql/);
assert.match(staleDetailIdentityRecoveryMigration,
  /binding\.actual_shop_name = shop\.expected_shop_name/);
assert.match(staleDetailIdentityRecoveryMigration,
  /拼多多订单详情的订单号与当前工单不一致/);
assert.match(staleDetailIdentityRecoveryMigration,
  /开发验收：验证码等待后切换下一单/);
assert.match(staleDetailIdentityRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(staleDetailIdentityRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'/);
assert.match(staleDetailIdentityRecoveryMigration,
  /ordinaryExactIdentityStaleDetailRecovery190/);
assert.match(staleDetailIdentityRecoveryMigration,
  /190_recover_exact_identity_stale_detail_pauses\.sql/);
assert.match(exactShipmentTmsWarehouseRecoveryMigration,
  /binding\.actual_shop_name = shop\.expected_shop_name/);
assert.match(exactShipmentTmsWarehouseRecoveryMigration,
  /'\["发货仓库不一致"\]'::jsonb/u);
assert.match(exactShipmentTmsWarehouseRecoveryMigration,
  /tmsAutofillVerification,actual,trackingNumber/);
assert.match(exactShipmentTmsWarehouseRecoveryMigration,
  /logisticsAnalysis,trackingNumber/);
assert.match(exactShipmentTmsWarehouseRecoveryMigration,
  /NOT EXISTS \([\s\S]*FROM external_effects effect/);
assert.match(exactShipmentTmsWarehouseRecoveryMigration,
  /tmsExactShipmentWarehouseRecovery191/);
assert.match(exactShipmentTmsWarehouseRecoveryMigration,
  /191_recover_exact_shipment_tms_warehouse_conflicts\.sql/);
assert.match(remainingDeterministicOrdinaryRecoveryMigration,
  /archive-confirmed-platform-terminal-state/);
assert.match(remainingDeterministicOrdinaryRecoveryMigration,
  /retry-abnormal-network-first-available-carrier/);
assert.match(remainingDeterministicOrdinaryRecoveryMigration,
  /retry-authorized-first-existing-tms-ticket/);
assert.match(remainingDeterministicOrdinaryRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(remainingDeterministicOrdinaryRecoveryMigration,
  /effect\.effect_type = 'evidence-upload'[\s\S]*effect\.status IN \('failed', 'unknown', 'reserved'\)/);
assert.match(remainingDeterministicOrdinaryRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('reserved', 'unknown', 'succeeded'\)/);
assert.match(remainingDeterministicOrdinaryRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(remainingDeterministicOrdinaryRecoveryMigration,
  /UPDATE ordinary_work_order_instances/);
assert.match(remainingDeterministicOrdinaryRecoveryMigration,
  /UPDATE notification_outbox/);
assert.match(remainingDeterministicOrdinaryRecoveryMigration,
  /192_recover_remaining_deterministic_ordinary_pauses\.sql/);
assert.match(auditedOrdinaryReconciliationMigration,
  /observe-pdd-state-before-any-continuation/);
assert.match(auditedOrdinaryReconciliationMigration,
  /pddSubmitAttemptsPreserved/);
assert.match(auditedOrdinaryReconciliationMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('succeeded', 'failed', 'unknown'\)/);
assert.match(auditedOrdinaryReconciliationMigration,
  /effect\.effect_type IN \('evidence-upload', 'tms-create'\)[\s\S]*effect\.status IN \('failed', 'unknown'\)/);
assert.match(auditedOrdinaryReconciliationMigration,
  /instance\.identity_status = 'verified'/);
assert.match(auditedOrdinaryReconciliationMigration,
  /effect\.effect_type = 'evidence-upload'[\s\S]*effect\.status IN \('failed', 'unknown', 'reserved'\)/);
assert.match(auditedOrdinaryReconciliationMigration,
  /193_resume_audited_ordinary_reconciliation\.sql/);
assert.match(transientOmsTmsQueryRecoveryMigration,
  /TMS 订单无法唯一自动带出/);
assert.match(transientOmsTmsQueryRecoveryMigration,
  /gateway time-\?out/);
assert.match(transientOmsTmsQueryRecoveryMigration,
  /订单编号\/交易号\/配货单号/);
assert.match(transientOmsTmsQueryRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown', 'succeeded'\)/);
assert.match(transientOmsTmsQueryRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(transientOmsTmsQueryRecoveryMigration,
  /reason_code <> 'image-upload-failed'/);
assert.match(transientOmsTmsQueryRecoveryMigration,
  /UPDATE notification_outbox/);
assert.match(transientOmsTmsQueryRecoveryMigration,
  /181_recover_transient_oms_tms_query_pauses\.sql/);
assert.match(terminalInterventionGuardMigration,
  /prevent_terminal_automatic_intervention_reopen/);
assert.match(terminalInterventionGuardMigration,
  /status IN \('completed', 'archived'\)/);
assert.match(terminalInterventionGuardMigration,
  /completion_state[\s\S]*IN \('confirmed', 'not-applicable'\)/);
assert.match(terminalInterventionGuardMigration,
  /NOT LIKE 'dingtalk:owner-manual:%'/);
assert.match(terminalInterventionGuardMigration,
  /UPDATE notification_outbox/);
assert.match(terminalInterventionGuardMigration,
  /182_prevent_terminal_intervention_reopen\.sql/);
assert.match(dataBackend,
  /!\['completed', 'archived'\]\.includes\(runtimeStatus\)/);
assert.match(dataBackend,
  /current_work_order\.status NOT IN \('completed', 'archived'\)[\s\S]*completion_state[\s\S]*NOT IN \('confirmed', 'not-applicable'\)/,
  'delayed browser events must recheck authoritative terminal state before opening interventions');
assert.match(returnRefundLoginVerificationMigration,
  /refund\.action_state = 'page-error'/);
assert.match(returnRefundLoginVerificationMigration,
  /检测到人工验证\|人工验证\|验证码\|pdd-manual-login\|human verification/);
assert.match(returnRefundLoginVerificationMigration,
  /effect\.effect_type = 'pdd-return-refund'[\s\S]*effect\.status IN \('reserved', 'unknown', 'succeeded'\)/);
assert.match(returnRefundLoginVerificationMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(returnRefundLoginVerificationMigration,
  /action_state = 'verification-required'/);
assert.match(returnRefundLoginVerificationMigration,
  /183_reclassify_return_refund_login_page_errors\.sql/);
assert.match(failedReadOnlyReconciliationRecoveryMigration,
  /184_recover_failed_read_only_reconciliations\.sql/);
assert.match(failedReadOnlyReconciliationRecoveryMigration,
  /external-state-reconciliation-failed/);
assert.match(failedReadOnlyReconciliationRecoveryMigration,
  /resume-read-only-reconciliation-no-resubmit/);
assert.match(failedReadOnlyReconciliationRecoveryMigration,
  /effect\.status = 'reserved'/);
assert.match(failedReadOnlyReconciliationRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(failedReadOnlyReconciliationRecoveryMigration,
  /verificationAttemptRefunded/);
assert.match(safeOrdinaryIdentityRebindMigration,
  /binding\.actual_shop_name = shop\.expected_shop_name/);
assert.match(safeOrdinaryIdentityRebindMigration,
  /instance\.identity_status = 'verified'[\s\S]*instance\.platform_case_key IS NOT NULL/);
assert.match(safeOrdinaryIdentityRebindMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('succeeded', 'unknown'\)/);
assert.match(safeOrdinaryIdentityRebindMigration,
  /ordinaryIdentityRebindRecovery186[\s\S]*safe-deterministic-ordinary-identity-rebound/);
assert.match(completedPageOutcomeRecoveryMigration, /completion_state = 'confirmed'/);
assert.match(completedPageOutcomeRecoveryMigration, /recoveredFromCompletedPage/);
assert.match(completedPageOutcomeRecoveryMigration, /completion-outcome-mismatch/);
assert.match(completedPageOutcomeRecoveryMigration, /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(returnRefundPageRecoveryMigration, /return-refund-page-error-recovered/);
assert.match(returnRefundPageRecoveryMigration, /refund\.detail_url IS NOT NULL/);
assert.match(returnRefundPageRecoveryMigration, /effect\.status IN \('reserved', 'unknown', 'succeeded'\)/);
assert.match(transientOmsRecoveryMigration, /OMS 生成配货单后未确认订单状态已越过配货阶段/);
assert.match(transientOmsRecoveryMigration, /transient-oms-pause-recovered/);
assert.match(misboundMedicalDeviceOrderMigration, /actualShopName' = 'PANAPOPO医疗器械官方旗舰店'/);
assert.match(misboundMedicalDeviceOrderMigration, /effect_type|external_effects/);
assert.match(misboundMedicalDeviceOrderMigration, /#- '\{latestDiscovery,pddIdentityBindingToken\}'/);
assert.match(misboundMedicalDeviceOrderMigration, /misbound-work-order-reassigned/);
assert.match(invalidPddDetailRecoveryMigration, /invalid-pdd-detail-url-recovered/);
assert.match(invalidPddDetailRecoveryMigration, /pddEvidenceScreenshot/);
assert.match(legacyMisboundMedicalDeviceOrderMigration, /260803-212965865810749/);
assert.match(legacyMisboundMedicalDeviceOrderMigration, /shopNameSnapshot' = 'PANAPOPO医疗器械官方旗舰店'/);
assert.match(legacyMisboundMedicalDeviceOrderMigration, /external_effects/);
assert.match(legacyMisboundMedicalDeviceOrderMigration, /preservedSucceededEffects/);
assert.match(deliveryRiskRuleUpgradeRecoveryMigration, /delivery-risk-rule-upgrade-pause-recovered/);
assert.match(deliveryRiskRuleUpgradeRecoveryMigration, /物流轨迹未更新，请如实填写/);
assert.match(deliveryRiskRuleUpgradeRecoveryMigration, /联系物流核实/);
assert.match(deliveryRiskRuleUpgradeRecoveryMigration, /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(deliveryRiskRuleUpgradeRecoveryMigration, /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('succeeded', 'unknown'\)/);
assert.match(deliveryRiskRuleUpgradeRecoveryMigration, /ordinary_work_order_instances/);
assert.match(deliveryRiskRuleUpgradeRecoveryMigration, /ordinary_instance_id/);
assert.match(readonlyDatePickerRecoveryMigration, /beast-core-datePicker-htmlInput/);
assert.match(readonlyDatePickerRecoveryMigration, /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(readonlyDatePickerRecoveryMigration, /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('succeeded', 'unknown'\)/);
assert.match(readonlyDatePickerRecoveryMigration, /ordinary_work_order_instances/);
assert.match(readonlyDatePickerRecoveryMigration, /readonly-date-picker-pause-recovered/);
assert.match(
  runner,
  /finishVerificationRetry[\s\S]*retryStep[\s\S]*status: 'retry-ready',[\s\S]*currentStep: retryStep/,
  'interrupted human verification must return to the retry queue instead of becoming permanently paused',
);
assert.match(
  runner,
  /challengeResolved[\s\S]*\? 1_000[\s\S]*'verification-cleared-retry-ready'[\s\S]*verificationLocation: null/,
  'a plugin-resolved challenge must clear stale verification state and retry immediately',
);
assert.match(workflow,
  /trigger: 'resident-browser-live-pages'[\s\S]*status: 'cleared'/,
  'the resident observer must publish durable evidence when a challenge disappears after a workflow timeout');
assert.match(runner, /releaseExpiredOwnedClaimForAuthenticationBlock/,
  'a login-blocked worker must clear an expired database lease before it waits for the operator');
assert.match(runner, /recoverOrphanedReservedExternalEffects/,
  'an orphaned reservation must enter read-only reconciliation instead of being replayed');
assert.match(runner,
  /system-safe-stop-before-effect-confirmation/,
  'a safe stop must mark an unconfirmed effect unknown before handing off its claim');
assert.match(runner,
  /const authenticationBlocked = onboardingStatus === 'waiting-login' \|\| workflowAuthenticationBlocked;[\s\S]*if \(authenticationBlocked && !activeClaim\)/,
  'a login-page challenge on any system must release an expired lease even when onboarding was not previously ready');
assert.match(
  runner,
  /verificationRetryDelaysMs = \[10 \* 60_000, 30 \* 60_000, 60 \* 60_000\]/,
  'verification retries must back off for 10, 30, then 60 minutes',
);
assert.match(runner, /async function restoreConfirmedPddShopIdentityBinding/);
assert.match(runner, /async function recoverMaskedPddShopIdentityBinding/);
assert.match(runner, /authHealth\?\.pdd\?\.status !== 'authenticated'/,
  'masked-name recovery requires a currently authenticated PDD session');
assert.match(runner, /binding\.identityStatus === 'revoked'[\s\S]*new Set\(fingerprints\)\.size === 1/,
  'masked-name recovery requires the revoked legacy binding and one matching browser fingerprint');
assert.match(runner, /hasCrossShopConflict[\s\S]*ROLLBACK/,
  'masked-name recovery must reject a fingerprint or identity already owned by another shop');
assert.match(runner, /maskedIdentityBound[\s\S]*currentPddIdentityBindingToken/,
  'a recovered masked identity may scan refunds only through its restored binding token');
assert.match(runner, /bindingToken !== runtimeBindingToken/);
assert.match(runner, /new Set\(fingerprints\)\.size === 1/);
assert.doesNotMatch(runner, /if \(currentPddIdentityBindingToken\) return true/,
  'a restored identity token alone must not bypass current-runner page validation');
assert.doesNotMatch(
  runner,
  /pddHealth\.status === 'expired'\s*\|\|\s*pddHealth\.status === 'verification-required'/,
  'a PDD challenge must not demote a confirmed shop to the login slot',
);
assert.match(
  runner,
  /await checkpointActiveClaim\(progress, \{ force: true \}\)[\s\S]*verificationExitReason[\s\S]*interruptedHumanVerification[\s\S]*await finishVerificationRetry\(progress, verificationExitReason, interruptedHumanVerification\)/,
  'workflow exit races must preserve verification retry handling',
);
assert.match(
  runner,
  /const clearsVerification[\s\S]*verificationRecovery: null/,
  'operator-confirmed verification recovery must reset the automatic backoff counter',
);
assert.match(runner, /claimNextExternalStateReconciliation/);
assert.equal(
  (productionEnvExample.match(/^WORKER_EXTERNAL_STATE_MAX_ATTEMPTS=/gmu) || []).length,
  1,
  'the production environment must define one authoritative external-state retry budget',
);
assert.match(productionEnvExample, /^WORKER_EXTERNAL_STATE_MAX_ATTEMPTS=6$/mu);
assert.match(runner, /WORKER_EXTERNAL_STATE_RETRY_MS \|\| 600_000/);
assert.match(runner, /WORKER_EXTERNAL_STATE_RETRY_WINDOW_MS \|\| 2_592_000_000/);
assert.match(runner, /WORKER_EXTERNAL_STATE_MAX_ATTEMPTS \|\| 6/);
assert.match(runner, /WORKER_EXTERNAL_STATE_FAIRNESS_CLAIMS \|\| 3/);
assert.match(runner, /retryAfterMs: externalStateRetryMs/);
assert.match(runner, /retryWindowMs: externalStateRetryWindowMs/);
assert.match(runner, /maxAttempts: externalStateMaxAttempts/);
assert.match(
  runner,
  /let externalStateReconciliationCheckedSinceStartup = false/,
  'each worker process must schedule one read-only external-state check after startup',
);
assert.match(
  runner,
  /!externalStateReconciliationCheckedSinceStartup[\s\S]{0,120}processedClaimsSinceExternalStateReconciliationCheck >= externalStateFairnessClaims/,
  'startup reconciliation must run once before the normal processed-claim fairness threshold',
);
assert.match(
  runner,
  /const processDueExternalStateReconciliation = async \(\) => \{[\s\S]{0,600}ordinaryEligibility\.active_claim > 0[\s\S]{0,300}externalStateReconciliationCheckedSinceStartup = true[\s\S]{0,160}processedClaimsSinceExternalStateReconciliationCheck = 0/,
  'startup/fairness reconciliation must remain blocked by an active claim and reset only after a real read-only check',
);
assert.match(
  runner,
  /const completedStartupLeaseRecoveryAttempt = startupLeaseRecoveryPending;[\s\S]{0,100}startupLeaseRecoveryPending = false;[\s\S]{0,240}!claim[\s\S]{0,240}completedStartupLeaseRecoveryAttempt[\s\S]{0,240}processDueExternalStateReconciliation/,
  'a completed empty startup lease lookup must trigger external-state reconciliation before discovery or scanning',
);
assert.match(
  runner,
  /if \(claim && !returnRefundOnly && !directRefundExecutionSession\) \{[\s\S]{0,120}processedClaimsSinceExternalStateReconciliationCheck \+= 1/,
  'ordinary and return-refund claims must both advance external-state reconciliation fairness',
);
assert.doesNotMatch(runner, /ordinaryClaimsSinceExternalStateReconciliationCheck/);
assert.match(runner, /runExternalStateReconciliation/);
assert.match(runner, /checkpointExternalStateReconciliation/);
assert.match(runner, /typeof progress\.error === 'string' \? progress\.error : null/);
assert.match(postgresAdapter, /status = 'retry-ready'/);
assert.match(postgresAdapter, /recovery_state = 'ready'/);
assert.match(postgresAdapter, /work_order\.recovery_state = 'held'/);
assert.match(postgresAdapter,
  /current_step = 'system-shutdown-drained'[\s\S]*recovery_reason = 'unknown-external-effect'[\s\S]*effect\.status = 'unknown'/u,
  'shutdown-drained unknown external effects must remain eligible for read-only reconciliation');
assert.match(postgresAdapter, /externalStateReconciliationRetry,attempts/);
assert.match(postgresAdapter,
  /END = \$4::int[\s\S]*current_step = 'system-shutdown-drained'[\s\S]*recovery_reason = 'unknown-external-effect'[\s\S]*postSubmitUnknownExtensionUsedAt\}' IS NULL/,
  'only an exhausted shutdown-drained unknown effect may use the one-time final reconciliation extension');
assert.match(postgresAdapter,
  /externalStateReconciliation,state\}' = 'not-applied'[\s\S]*externalStateReconciliation,effectType\}' = 'oms-reissue-create'[\s\S]*externalStateReconciliation,readOnly\}' = 'true'[\s\S]*externalStateReconciliation,externalActionsReplayed\}' = 'false'[\s\S]*jsonb_array_length[\s\S]*>= 2/,
  'the OMS extension must require prior two-pass read-only not-applied evidence');
assert.match(postgresAdapter,
  /effect\.effect_type = 'oms-reissue-create'[\s\S]*effect\.status = 'unknown'[\s\S]*OMS 补发提交后未回查到新的补发订单标识[\s\S]*effect\.reserved_at > CASE/,
  'the OMS extension must bind a later exact unknown submit effect');
assert.match(postgresAdapter,
  /postSubmitUnknownExtensionUsedAt', now\(\)[\s\S]*postSubmitUnknownExtensionPurpose'[\s\S]*read-only-oms-reconciliation-after-unknown-submit/,
  'the one-time extension must leave a durable audit marker');
assert.match(postgresAdapter, /interruptedAttemptRefundedAt/);
assert.match(postgresAdapter,
  /async failExternalStateReconciliation[\s\S]*current_step = 'external-state-unresolved'[\s\S]*external-state-reconciliation-retry-pending/);
assert.match(runner,
  /deferExternalStateReconciliationForVerification[\s\S]*external-state-reconciliation-verification-required/);
assert.match(postgresAdapter,
  /async deferExternalStateReconciliationForVerification[\s\S]*verificationAttemptRefundedAt/);
assert.match(postgresAdapter,
  /work_order\.current_step IN \([\s\S]*'external-state-unresolved',[\s\S]*'human-verification-required'/);
assert.match(postgresAdapter,
  /coalesce\([\s\S]*work_order\.recovery_updated_at,[\s\S]*work_order\.updated_at,[\s\S]*work_order\.created_at[\s\S]*\) >= now\(\) - \(\$3::bigint \* interval '1 millisecond'\)/);
assert.match(postgresAdapter, /END < \$4::int/);
assert.match(postgresAdapter, /ORDER BY work_order\.updated_at DESC/);
assert.match(postgresAdapter, /transitionWorkOrderByCommand[\s\S]*recovery_state = CASE WHEN \$3 = 'retry-ready' THEN 'ready'/);
assert.match(postgresAdapter, /recovery_reason = 'operator-recovery-freeze'/);
assert.match(postgresAdapter, /current_step LIKE 'external-state-%'/);
assert.match(postgresAdapter,
  /effect\.effect_type IN \([\s\S]*'tms-create', 'pdd-note', 'pdd-submit', 'oms-manual-allocation'/,
  'TMS creates must participate in the read-only external-state queue');
assert.match(postgresAdapter, /effect\.status IN \('succeeded', 'failed'\)[\s\S]*effect\.effect_type = 'pdd-submit'/);
assert.match(postgresAdapter, /retryablePddSubmitNotApplied/);
assert.match(postgresAdapter, /reconciledEffectType === 'pdd-note'[\s\S]*pddOrderRemark:[\s\S]*status: 'saved'/);
assert.match(postgresAdapter, /\$5 = 'pdd-submit' AND status = 'succeeded'/);
assert.match(postgresAdapter, /idempotency_key LIKE '%:resolution-postcondition-retry-v2'/);
assert.match(postgresAdapter,
  /intermediateReconciliation = \[[\s\S]*'tms-create'[\s\S]*'pdd-note'[\s\S]*'oms-manual-allocation'[\s\S]*'oms-reissue-create'/);
assert.match(postgresAdapter,
  /reconciledEffectType === 'tms-create'[\s\S]*tms-create-reconciled[\s\S]*tms-create-not-applied/);
assert.match(postgresAdapter,
  /UPDATE ordinary_work_order_instances instance SET[\s\S]*status = 'retry-ready'[\s\S]*payload = \$4::jsonb/,
  'read-only continuation must synchronize the current ordinary instance');
assert.match(workflow,
  /const reconcileTmsCreateState = async[\s\S]*unique-exact-tms-ticket-and-identity-match[\s\S]*refreshed-two-pass-exact-zero-result/,
  'an uncertain TMS create must use a unique identity match or a refreshed two-pass zero result');
assert.match(workflow,
  /reconcileExternalEffectTypes\.has\('tms-create'\)[\s\S]*reconcileTmsCreateState/,
  'the resident workflow must route uncertain TMS creates before opening PDD');
assert.match(postgresAdapter,
  /async recoverSafePddDetailPauses[\s\S]*PDD_DETAIL_TEMPORARILY_UNAVAILABLE[\s\S]*未找到目标待处理工单[\s\S]*fresh-exact-order-query/,
  'safe PDD detail pauses must be continuously recovered through a fresh exact query');
assert.match(postgresAdapter,
  /async recoverSafePddDetailPauses[\s\S]*instance\.identity_status = 'verified'[\s\S]*instance\.platform_case_key IS NOT NULL[\s\S]*binding\.mall_id = coalesce[\s\S]*bindingRebound[\s\S]*previousTransientRecoveryCount/,
  'stale PDD detail bindings require strong shop identity and must reset the transient retry budget');
assert.match(postgresAdapter,
  /instance\.identity_status = 'legacy-unverified'[\s\S]*instance\.platform_case_id IS NULL[\s\S]*pddShopIdentity,actualShopName[\s\S]*ambiguous_shop/,
  'legacy PDD detail pauses may only rebind from an exact observed shop identity');
assert.match(postgresAdapter,
  /page\[\.\]\(waitForURL\|goto\|reload\): Timeout \[0-9\]\+ms exceeded[\s\S]*instance\.detail_url[\s\S]*mms\[\.\]pinduoduo\[\.\]com\/aftersales\/work_order\/tododetail/,
  'persisted PDD navigation pauses must accept a verified instance detail URL');
assert.match(runner,
  /拼多多\[\^\\r\\n\]\*刷新后等待 \\d\+ 毫秒仍未出现有效结果/,
  'all PDD render-wait stage labels must enter the bounded fast retry path');
assert.match(runner,
  /recoverSafePddDetailPauses[\s\S]*ordinary-safe-pdd-detail-auto-recovered/);
assert.match(postgresAdapter, /async hasValidLease/);
assert.match(postgresAdapter, /status = 'paused'[\s\S]*human-verification-required/);
assert.match(postgresAdapter, /runtime_status = CASE[\s\S]*THEN 'verification'/);
assert.match(postgresAdapter,
  /UPDATE work_orders w SET current_step = \$4,[\s\S]*payload = \$5::jsonb[\s\S]*latestDiscovery[\s\S]*runtime_status = \$6/,
  'workflow checkpoints must preserve immutable discovery identity metadata');
assert.match(workflow, /workOrderType: activeWorkOrderType/);
assert.match(workflow, /scenarioCode: activeScenarioCode/);
assert.match(
  workflow,
  /const selectedType = requestedOrderNumber[\s\S]*?activeWorkOrderType[\s\S]*?const selectedScenarioCode = requestedOrderNumber[\s\S]*?activeScenarioCode/,
  'requested-order lookup must preserve the claimed work-order type and scenario',
);
assert.match(workflow, /browser\.once\('disconnected'/);
assert.match(workflow, /maybeBringToFront\(targetPage, \{ manual: true \}\)/);
assert.match(workflow, /const shouldActivate = force[\s\S]*\|\| workflowForegroundMode === 'always'[\s\S]*\|\| verification[\s\S]*workflowForegroundMode === 'manual-only' && manual/);
assert.match(workflow, /const createBackgroundPage = async \(\) =>/);
assert.match(workflow, /Target\.createTarget', \{ url: 'about:blank', background: true \}/);
assert.match(workflow, /closeBrowserBeforeExit\(browserDisconnectedExitCode, reason, error\)/,
  'browser disconnect recovery must close the persistent context before the runner restarts it');
assert.match(workflow, /Browser\.getVersion/);
assert.match(workflow, /WORKFLOW_ALLOW_MANUAL_EXTENSIONS/);
assert.match(workflow, /WORKFLOW_EXPECTED_BROWSER_VERSION/);
assert.match(
  workflow,
  /if \(required\.has\('OMS'\) && required\.has\('TMS'\)\) \{[\s\S]{0,260}ensureOmsLogin\(omsPage, context\)/,
  'OMS must be revalidated after TMS navigation before a multi-system workflow continues',
);
assert.match(workflow, /resolveBrowserProxyConfig\(\{[\s\S]*directHosts:[\s\S]*omsLoginUrl[\s\S]*tmsBaseUrl/);
assert.match(workflow, /browserProxy \? \{ proxy: browserProxy \} : \{\}/);
assert.match(slotSupervisor, /env: \{\s*\.\.\.process\.env,/,
  'new shop slots must inherit the global browser proxy configuration');
assert.match(runner, /const childEnv = \{\s*\.\.\.process\.env,/,
  'each shop browser must inherit the global browser proxy configuration');
assert.match(runner,
  /const proxyHealth = await inspectConfiguredBrowserProxy\(\)[\s\S]{0,500}if \(!proxyHealth\.ok\)[\s\S]{0,500}heartbeat\('browser-proxy-unavailable'[\s\S]{0,500}continue;/,
  'an unavailable proxy must block new claims and browser commands without restarting the resident browser');
assert.match(runner,
  /WORKER_BROWSER_PROXY_NAVIGATION_FAILURE_LIMIT[\s\S]*advanceBrowserProxyNavigationFailureCircuit/,
  'browser-level proxy failures must have a bounded per-shop circuit');
assert.match(runner, /WORKER_BROWSER_PROXY_NAVIGATION_MAX_COOLDOWN_MS/,
  'persistent proxy failures must use a capped adaptive cooldown');
assert.match(runner,
  /recoveryProbeStartedAt[\s\S]{0,300}browserProxyHealth = null/,
  'an expired circuit must retain its outage history while forcing one recovery probe');
assert.match(runner,
  /BROWSER_PROXY_NAVIGATION_CIRCUIT_OPEN[\s\S]*continue;[\s\S]*inspectConfiguredBrowserProxy/,
  'an open browser-level proxy circuit must pause before the next claim');
assert.match(runner,
  /successful-business-turn-after-navigation-cooldown/,
  'the dashboard must not claim proxy recovery until a real business turn succeeds');
assert.match(runner,
  /output\.result\?\.outcome === 'page-error'[\s\S]*recordBrowserProxyNavigationFailure/,
  'return-refund page failures must feed the proxy circuit');
assert.match(runner,
  /const rethrowReturnRefundScanProxyFailure = \(error\) => \{[\s\S]{0,220}detectBrowserProxyNavigationFailure\(error\)[\s\S]{0,80}throw error/,
  'return-refund scan failures must recognize browser-level proxy navigation errors');
assert.equal(
  (runner.match(/rethrowReturnRefundScanProxyFailure\(error\);/g) || []).length,
  1,
  'the shared scan-failure handler must feed browser-level proxy failures to the circuit once',
);
assert.equal(
  (runner.match(/await deferReturnRefundScanAfterFailure\(error\);/g) || []).length,
  4,
  'every return-refund scan catch path must use the shared retry and proxy-failure handler',
);
assert.match(runner,
  /const browserProxyNavigationFailure = recordBrowserProxyNavigationFailure\(reason\);[\s\S]*retryableTransientWorkflowFailure\(progress\)/,
  'ordinary workflow failures must feed the same proxy circuit before manual classification');
assert.match(dataBackend,
  /heartbeatState === 'browser-proxy-unavailable'[\s\S]{0,700}runtimeStatus: blockingStep === 'browser-proxy-unavailable' \? 'paused'/,
  'the dashboard must expose proxy failure as infrastructure pause rather than captcha');
assert.match(shopsView, /当前代理不可用/);
assert.match(workflow, /--force-device-scale-factor=1/);
assert.match(workflow, /browserScaleIsExpected\(browserScale\)/);
assert.deepEqual(resolveBrowserProxyConfig({ env: {} }), {
  launch: null,
  runtime: { enabled: false, required: false },
});
assert.equal(resolveBrowserProxyConfig({
  env: {
    WORKFLOW_BROWSER_PROXY_REQUIRED: 'true',
    WORKFLOW_BROWSER_PROXY_SERVER: 'http://127.0.0.1:8888',
    WORKFLOW_BROWSER_PROXY_USERNAME: 'user',
    WORKFLOW_BROWSER_PROXY_PASSWORD: 'password',
    WORKFLOW_BROWSER_PROXY_EXPIRES_AT: '4102444800',
  },
}).runtime.authenticated, true);
const parsedProxyEnvironment = parseBrowserProxyEnvironment(`
WORKFLOW_BROWSER_PROXY_REQUIRED=true
WORKFLOW_BROWSER_PROXY_SERVER=http://private-proxy.example:8888
WORKFLOW_BROWSER_PROXY_USERNAME='private-user'
WORKFLOW_BROWSER_PROXY_PASSWORD="private-password"
WORKFLOW_BROWSER_PROXY_EXPIRES_AT=4102444800
`);
const staticProxyReport = inspectBrowserProxyConfiguration({
  env: parsedProxyEnvironment,
  now: Date.parse('2026-08-22T00:00:00.000Z'),
});
assert.deepEqual(staticProxyReport, {
  ok: true,
  enabled: true,
  required: true,
  authenticated: true,
  expiresAt: '2100-01-01T00:00:00.000Z',
  validationMode: 'configuration-only',
  checkedAt: '2026-08-22T00:00:00.000Z',
});
assert.equal(JSON.stringify(staticProxyReport).includes('private-proxy'), false,
  'configuration-only output must not expose the proxy endpoint');
assert.equal(JSON.stringify(staticProxyReport).includes('private-user'), false,
  'configuration-only output must not expose proxy credentials');
assert.throws(() => inspectBrowserProxyConfiguration({
  env: {
    ...parsedProxyEnvironment,
    WORKFLOW_BROWSER_PROXY_EXPIRES_AT: '2026-08-22T00:00:00.000Z',
  },
  now: Date.parse('2026-08-22T00:00:00.001Z'),
}), /Configured browser proxy expired at 2026-08-22T00:00:00\.000Z/);
const directBusinessProxy = resolveBrowserProxyConfig({
  env: {
    WORKFLOW_BROWSER_PROXY_SERVER: 'http://127.0.0.1:8888',
    WORKFLOW_BROWSER_PROXY_BYPASS: 'localhost;127.0.0.1,localhost',
  },
  directHosts: ['www.jeoms.com', 'tms.aipro123.top'],
});
assert.equal(
  directBusinessProxy.launch.bypass,
  'localhost,127.0.0.1,www.jeoms.com,tms.aipro123.top',
);
assert.equal(directBusinessProxy.runtime.bypass, directBusinessProxy.launch.bypass);
let successfulProxyDial;
let proxyClock = 1_000;
const reachableProxy = await probeBrowserProxyConnectivity({
  runtime: directBusinessProxy.runtime,
  dial: async (endpoint) => { successfulProxyDial = endpoint; },
  now: () => { proxyClock += 25; return proxyClock; },
});
assert.equal(reachableProxy.ok, true);
assert.deepEqual(successfulProxyDial, { host: '127.0.0.1', port: 8888, timeoutMs: 5_000 });
assert.deepEqual(detectBrowserProxyNavigationFailure(
  'page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at https://mms.pinduoduo.com/aftersales-ssr/detail',
), { errorCode: 'ERR_HTTP_RESPONSE_CODE_FAILURE' });
assert.deepEqual(detectBrowserProxyNavigationFailure(
  new Error('page.goto: net::ERR_PROXY_CONNECTION_FAILED'),
), { errorCode: 'ERR_PROXY_CONNECTION_FAILED' });
assert.equal(detectBrowserProxyNavigationFailure(
  'page.goto: Timeout 30000ms exceeded while loading one PDD page',
), null, 'an ordinary page timeout must not open the proxy circuit');
let proxyNavigationCircuit = null;
for (let index = 0; index < 2; index += 1) {
  const result = advanceBrowserProxyNavigationFailureCircuit({
    state: proxyNavigationCircuit,
    error: 'page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE',
    proxyEnabled: true,
    now: index * 30_000,
    failureWindowMs: 120_000,
    failureLimit: 3,
    cooldownMs: 120_000,
  });
  assert.equal(result.matched, true);
  assert.equal(result.opened, false);
  proxyNavigationCircuit = result.state;
}
const openedProxyNavigationCircuit = advanceBrowserProxyNavigationFailureCircuit({
  state: proxyNavigationCircuit,
  error: 'page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE',
  proxyEnabled: true,
  now: 60_000,
  failureWindowMs: 120_000,
  failureLimit: 3,
  cooldownMs: 120_000,
});
assert.equal(openedProxyNavigationCircuit.opened, true);
assert.equal(openedProxyNavigationCircuit.state.count, 3);
assert.equal(openedProxyNavigationCircuit.state.openCount, 1);
assert.equal(openedProxyNavigationCircuit.state.cooldownMs, 120_000);
assert.equal(openedProxyNavigationCircuit.state.openUntil, '1970-01-01T00:03:00.000Z');
const reopenedProxyNavigationCircuit = advanceBrowserProxyNavigationFailureCircuit({
  state: openedProxyNavigationCircuit.state,
  error: 'page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE',
  proxyEnabled: true,
  now: 180_001,
  failureWindowMs: 120_000,
  failureLimit: 3,
  cooldownMs: 120_000,
  maxCooldownMs: 600_000,
});
assert.equal(reopenedProxyNavigationCircuit.opened, true,
  'the first failed recovery probe must reopen the circuit immediately');
assert.equal(reopenedProxyNavigationCircuit.state.openCount, 2);
assert.equal(reopenedProxyNavigationCircuit.state.cooldownMs, 240_000);
assert.equal(reopenedProxyNavigationCircuit.state.openUntil, '1970-01-01T00:07:00.001Z');
const cappedProxyNavigationCircuit = advanceBrowserProxyNavigationFailureCircuit({
  state: { ...reopenedProxyNavigationCircuit.state, openCount: 3 },
  error: 'page.goto: net::ERR_TUNNEL_CONNECTION_FAILED',
  proxyEnabled: true,
  now: 420_002,
  failureWindowMs: 120_000,
  failureLimit: 3,
  cooldownMs: 120_000,
  maxCooldownMs: 600_000,
});
assert.equal(cappedProxyNavigationCircuit.state.openCount, 4);
assert.equal(cappedProxyNavigationCircuit.state.cooldownMs, 600_000);
assert.equal(cappedProxyNavigationCircuit.state.openUntil, '1970-01-01T00:17:00.002Z');
const restartedProxyNavigationWindow = advanceBrowserProxyNavigationFailureCircuit({
  state: proxyNavigationCircuit,
  error: 'page.goto: net::ERR_TUNNEL_CONNECTION_FAILED',
  proxyEnabled: true,
  now: 180_001,
  failureWindowMs: 120_000,
  failureLimit: 3,
  cooldownMs: 120_000,
});
assert.equal(restartedProxyNavigationWindow.opened, false);
assert.equal(restartedProxyNavigationWindow.state.count, 1,
  'a failure outside the rolling window must start a new circuit window');
assert.equal(advanceBrowserProxyNavigationFailureCircuit({
  state: null,
  error: 'page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE',
  proxyEnabled: false,
  now: 0,
}).matched, false, 'direct browser mode must not classify an origin response as a proxy outage');
const unreachableProxy = await probeBrowserProxyConnectivity({
  runtime: directBusinessProxy.runtime,
  dial: async () => {
    const error = new Error('refused');
    error.code = 'ECONNREFUSED';
    throw error;
  },
});
assert.equal(unreachableProxy.ok, false);
assert.equal(unreachableProxy.errorCode, 'ECONNREFUSED');
const startupProxyReport = await inspectWorkerBrowserProxy({
  env: { WORKFLOW_BROWSER_PROXY_SERVER: 'http://127.0.0.1:8888' },
  dial: async () => {},
  now: () => 0,
});
assert.equal(startupProxyReport.ok, true);
assert.equal(startupProxyReport.port, 8888);
assert.equal(JSON.stringify(startupProxyReport).includes('127.0.0.1'), false,
  'the startup preflight must not print the configured proxy endpoint');
const probeLocalHttpProxy = async ({ statusCode, username = '', password = '' }) => {
  let requestHeaders = '';
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      requestHeaders += chunk.toString('latin1');
      if (!requestHeaders.includes('\r\n\r\n')) return;
      socket.end(`HTTP/1.1 ${statusCode} ${statusCode === 200 ? 'Connection Established' : 'Rejected'}\r\n\r\n`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const config = resolveBrowserProxyConfig({
    env: {
      WORKFLOW_BROWSER_PROXY_SERVER: `http://127.0.0.1:${address.port}`,
      ...(username ? {
        WORKFLOW_BROWSER_PROXY_USERNAME: username,
        WORKFLOW_BROWSER_PROXY_PASSWORD: password,
      } : {}),
    },
  });
  try {
    return {
      health: await probeBrowserProxyConnectivity({ runtime: config.runtime, timeoutMs: 2_000 }),
      requestHeaders,
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};
const authenticatedConnectProbe = await probeLocalHttpProxy({
  statusCode: 200,
  username: 'probe-user',
  password: 'probe-password',
});
assert.equal(authenticatedConnectProbe.health.ok, true);
assert.equal(authenticatedConnectProbe.health.validationMode, 'https-connect');
assert.match(authenticatedConnectProbe.requestHeaders,
  /^CONNECT mms\.pinduoduo\.com:443 HTTP\/1\.1\r\n/mu);
assert.match(authenticatedConnectProbe.requestHeaders,
  new RegExp(`Proxy-Authorization: Basic ${Buffer.from('probe-user:probe-password').toString('base64')}`, 'u'));
assert.equal(JSON.stringify(authenticatedConnectProbe.health).includes('probe-password'), false,
  'proxy credentials must never enter the health report');
const rejectedConnectProbe = await probeLocalHttpProxy({ statusCode: 407 });
assert.equal(rejectedConnectProbe.health.ok, false);
assert.equal(rejectedConnectProbe.health.errorCode, 'PROXY_AUTH_REQUIRED');
const unavailableUpstreamProbe = await probeLocalHttpProxy({ statusCode: 504 });
assert.equal(unavailableUpstreamProbe.health.ok, false);
assert.equal(unavailableUpstreamProbe.health.errorCode, 'PROXY_UPSTREAM_UNAVAILABLE');
await assert.rejects(
  () => inspectWorkerBrowserProxy({
    env: { WORKFLOW_BROWSER_PROXY_SERVER: 'http://127.0.0.1:8888' },
    dial: async () => {
      const error = new Error('refused');
      error.code = 'ECONNREFUSED';
      throw error;
    },
    now: () => 0,
  }),
  (error) => error.code === 'BROWSER_PROXY_UNAVAILABLE'
    && error.report.errorCode === 'ECONNREFUSED'
    && !JSON.stringify(error.report).includes('127.0.0.1'),
);
assert.deepEqual(await probeBrowserProxyConnectivity({
  runtime: { enabled: false, required: false },
  now: () => 0,
}), {
  ok: true,
  enabled: false,
  required: false,
  checkedAt: '1970-01-01T00:00:00.000Z',
});
assert.throws(
  () => resolveBrowserProxyConfig({ env: { WORKFLOW_BROWSER_PROXY_REQUIRED: 'true' } }),
  /requires WORKFLOW_BROWSER_PROXY_SERVER/,
);
assert.throws(
  () => resolveBrowserProxyConfig({
    env: {
      WORKFLOW_BROWSER_PROXY_SERVER: 'http://127.0.0.1:8888',
      WORKFLOW_BROWSER_PROXY_EXPIRES_AT: 'not-a-timestamp',
    },
  }),
  /must be an ISO timestamp or Unix timestamp/,
);
assert.throws(
  () => resolveBrowserProxyConfig({
    env: {
      WORKFLOW_BROWSER_PROXY_SERVER: 'http://127.0.0.1:8888',
      WORKFLOW_BROWSER_PROXY_EXPIRES_AT: '1700000000',
    },
  }),
  /Configured browser proxy expired/,
);
assert.equal(browserScaleIsExpected({
  devicePixelRatio: 1,
  visualViewportScale: 1,
  innerWidth: 1920,
  innerHeight: 1080,
}), true);
let browserScaleInspectionAttempts = 0;
const recoveredBrowserScale = await inspectBrowserScale({
  evaluate: async () => {
    browserScaleInspectionAttempts += 1;
    if (browserScaleInspectionAttempts < 8) {
      throw new Error('Execution context was destroyed, most likely because of a navigation');
    }
    return {
      devicePixelRatio: 1,
      visualViewportScale: 1,
      innerWidth: 1920,
      innerHeight: 1080,
    };
  },
}, { delay: async () => {} });
assert.equal(browserScaleInspectionAttempts, 8,
  'browser scale inspection must tolerate a sustained transient startup navigation race');
assert.equal(browserScaleIsExpected(recoveredBrowserScale), true);
assert.match(workflow, /!isReturnRefundDetailUrl\(url\)/);
assert.match(workflow, /page\.url\(\) === 'about:blank' \|\| isReturnRefundDetailUrl\(page\.url\(\)\)/);
assert.match(workflow, /WORKFLOW_EXTENSION_STARTUP_TIMEOUT_MS/);
assert.match(workflow, /manualExtensionsAllowed: browserAllowsManualExtensions/);
assert.match(workflow, /\['--disable-extensions'\]/);
assert.match(workflow, /missingManualExtensions = browserAllowsManualExtensions/);
assert.match(workflow, /if \(!browserAllowsManualExtensions\) throw new Error\(message\)/);
assert.match(workflow, /continuing because manual extensions are allowed/);
assert.match(workflow, /WORKFLOW_BROWSER_HEALTH_INTERVAL_MS/);
assert.match(workflow, /WORKFLOW_BROWSER_HEALTH_PROBE_FAILURE_LIMIT \|\| 4/);
assert.match(workflow, /decideBrowserProbeFailure\(\{/);
assert.match(workflow,
  /sendBrowserPrelaunchHealth[\s\S]*phase: 'launching-persistent-context'[\s\S]*setInterval\(sendBrowserPrelaunchHealth, 5_000\)/,
  'the worker must receive health pulses while the persistent context is still launching');
assert.match(workflow,
  /const savedStartupStorageState = loadCombinedStorageState\(\[[\s\S]*omsStatePath[\s\S]*Injecting its IndexedDB snapshot here can block Chromium startup[\s\S]*\]\);/,
  'TMS must rely on its persistent profile instead of blocking startup on snapshot injection');
assert.doesNotMatch(
  workflow.slice(workflow.indexOf('const savedStartupStorageState'), workflow.indexOf('const extensionSecurePreferencesFile')),
  /storagePath: tmsStatePath/,
  'TMS snapshot injection must not run before the resident browser is visible');
assert.match(workflow,
  /sendBrowserStartupHealth[\s\S]*phase: 'initializing-resident-tabs'[\s\S]*setInterval\([\s\S]*sendBrowserStartupHealth/,
  'slow resident tab initialization must continue publishing browser health');
const residentDiscoveryInitialization = workflow.slice(
  workflow.indexOf('const initializeResidentSystemsForDiscovery'),
  workflow.indexOf('let pageCrashRecoveryAttempts'),
);
assert.match(residentDiscoveryInitialization, /if \(!returnRefundPddOnlyMode\)/,
  'PDD-only refund sessions must not open OMS or TMS');
assert.match(residentDiscoveryInitialization, /residentOmsWarmupPromise = \(async \(\) =>/);
assert.doesNotMatch(residentDiscoveryInitialization, /await residentOmsWarmupPromise/,
  'OMS warmup must remain in the background and must not delay resident PDD readiness');
assert.match(residentDiscoveryInitialization, /residentTmsWarmupPromise = navigateSystemPage/);
assert.doesNotMatch(residentDiscoveryInitialization, /await residentTmsWarmupPromise/,
  'TMS warmup must remain in the background and must not delay resident PDD readiness');
assert.match(residentDiscoveryInitialization,
  /return \{[\s\S]{0,120}omsWarmup: residentOmsWarmupPromise,[\s\S]{0,120}tmsWarmup: residentTmsWarmupPromise/);
assert.match(workflow,
  /if \(residentOmsWarmupPromise\) \{[\s\S]{0,180}residentOmsWarmupExpediteResolver\?\.\(\);[\s\S]{0,120}await residentOmsWarmupPromise/,
  'an OMS-dependent claim must reuse and expedite the existing resident warmup');
assert.match(workflow,
  /openTmsCustomerRegistration[\s\S]{0,220}await residentTmsWarmupPromise/,
  'a claimed TMS workflow must await the background startup login before using its anchor');
assert.match(workflow,
  /if \(browserStartupHealthTimer\) \{[\s\S]*clearInterval\(browserStartupHealthTimer\)[\s\S]*const healthTimer = setInterval/,
  'startup health must hand over to the full CDP probe after resident initialization');
assert.equal(decideBrowserProbeFailure({
  connected: true,
  pageCount: 3,
  failureCount: 1,
  failureLimit: 4,
  error: new Error('Chromium CDP probe timed out'),
}).restart, false, 'one transient browser probe timeout must keep the resident shop window alive');
assert.equal(decideBrowserProbeFailure({
  connected: true,
  pageCount: 3,
  failureCount: 4,
  failureLimit: 4,
  error: new Error('Chromium CDP probe timed out'),
}).restart, true, 'the configured consecutive browser probe failure limit must trigger recovery');
assert.equal(decideBrowserProbeFailure({
  connected: false,
  pageCount: 3,
  failureCount: 1,
  failureLimit: 4,
  error: new Error('Chromium connection is closed'),
}).restart, true, 'a definitively disconnected browser must recover immediately');
assert.match(workflow,
  /const unavailableResidentSystemTabs = \(\) => \[[\s\S]{0,240}returnRefundPddOnlyMode[\s\S]{0,240}page\.isClosed\(\)/,
  'resident health must distinguish a missing PDD, OMS, or TMS anchor from harmless derived tabs');
assert.match(workflow,
  /const missingSystemTabs = unavailableResidentSystemTabs\(\);[\s\S]{0,160}Resident system tabs closed/,
  'a manually closed resident system tab must enter bounded browser recovery');
assert.match(workflow,
  /missingSystemTabs,[\s\S]{0,160}probeFailureCount: decision\.failureCount/,
  'browser health telemetry must identify which resident system tab disappeared');
assert.match(workflow, /message\?\.type === 'browser-health-restart'/);
assert.match(workflow, /class PddLoginRequiredError extends Error[\s\S]*this\.code = 'PDD_LOGIN_REQUIRED'/,
  'PDD login loss must have a dedicated interruption type');
assert.match(workflow,
  /recordPddLoginRequired[\s\S]*step: 'manual-login-required'[\s\S]*systemLogin:[\s\S]*status: 'required'/,
  'PDD login loss must persist authentication state without fabricating verification');
assert.match(workflow,
  /拼多多登录后仍返回登录页[\s\S]{0,200}recordPddLoginRequired|recordPddLoginRequired[\s\S]{0,200}拼多多登录后仍返回登录页/u,
  'a page that remains on PDD login must not throw an unclassified Error');
assert.match(workflow,
  /error instanceof PddLoginRequiredError\) return 'login-required'/,
  'resident commands must report PDD login loss separately from verification and flow failures');
assert.match(runner,
  /const progressBeforeAuthentication = await readProgress[\s\S]{0,360}const authentication = workflowAuthenticationState\(progressBeforeAuthentication, \{[\s\S]{0,100}requiredSystems: \['pdd'\][\s\S]{0,80}\}\);[\s\S]*if \(authentication\.blocked\)[\s\S]*return false/,
  'the Worker must not claim new work while any required system login is blocked');
assert.match(runner,
  /classifyResidentLoginInterruption[\s\S]*finishLoginRetry[\s\S]*login-required-retry-ready/,
  'a login-interrupted active claim must be released and safely queued for resume');
assert.match(workflow, /resetResidentAssignment\(\{ outcome: 'flow-paused' \}\);/);
assert.match(workflow,
  /residentCommandMode[\s\S]{0,160}error instanceof HumanVerificationRequiredError[\s\S]{0,160}error instanceof PddLoginRequiredError[\s\S]{0,160}error instanceof RateLimitPauseError[\s\S]{0,900}verificationPause[\s\S]{0,200}loginPause[\s\S]{0,700}if \(!verificationPause && !loginPause\)[\s\S]{0,300}closeDerivedPage\(page\)[\s\S]{0,300}resetResidentAssignment\(\{ outcome \}\)/,
  'resident login and verification must retain their visible page while rate limits clean up derived tabs');
assert.match(workflow, /const pddSavedDetailNeedsFreshLookup = \(progress = \{\}\) =>/);
assert.match(workflow, /progress\.detailUrl && !isPddDetailUrl\(progress\.detailUrl\)/);
assert.match(workflow, /progress\.pddStaleDetailRecovery\?\.strategy === 'fresh-exact-order-query'/);
assert.match(workflow, /const canResumeSavedDetail = Boolean\(isPddDetailUrl\(progress\.detailUrl\)\s*&& !pddSavedDetailNeedsFreshLookup\(progress\)/);
assert.match(workflow, /if \(!isPddDetailUrl\(detailUrl\)\) \{[\s\S]*不是工单详情页/);
assert.match(
  workflow,
  /if \(residentCommandMode\) \{[\s\S]*?saveWorkflowDiagnostics\(activePage, 'flow-paused'[\s\S]*?for \(const page of \[\.\.\.derivedPages\]\)[\s\S]*?closeDerivedPage\(page\)/,
  'resident flow failures must close derived PDD tabs before accepting the next order',
);
assert.match(browserHealthMonitor, /browser-heartbeat-startup-timeout/);
assert.match(browserHealthMonitor, /browser-heartbeat-timeout/);
assert.match(runner, /stdio: \['ignore', 'inherit', 'inherit', 'ipc'\]/);
assert.match(workflow, /guardedExternalEffect/);
assert.match(workflow, /releaseAction = externalEffectGuardEnabled/);
assert.match(workflow, /if \(externalEffectGuardEnabled\) \{[\s\S]*await finishDiscoveryRun\(\);[\s\S]*break;/);
assert.match(workflow, /PDD_RATE_LIMIT_MAX_WAIT_MS/);
assert.match(workflow, /step: retryOnRateLimit \? 'rate-limited-waiting' : 'rate-limited'/);
assert.match(workflow, /rateLimitWaitMs \* \(2 \*\* Math\.min\(attempt - 1, 8\)\)/);
assert.match(workflow, /\[平台限流恢复\]/);
assert.match(workflow, /'open-pinduoduo-target',[\s\S]*\{ retryOnRateLimit: true \}/);
assert.match(workflow, /const withOmsSessionLock = async/);
assert.match(workflow, /OMS_READY_TIMEOUT_MS \|\| '30000'/,
  'OMS must yield a broken Loading page after a bounded 30-second render window');
assert.match(workflow, /OMS_NAVIGATION_TIMEOUT_MS \|\| '30000'/,
  'OMS recovery navigation must not monopolize the cross-shop lock for 90 seconds');
assert.match(workflow, /commitTimeoutMs: omsNavigationTimeoutMs/,
  'OMS controlled recovery must use the bounded navigation timeout');
assert.match(workflow, /step: 'oms-login-retry-deferred'[\s\S]*status: 'retry-ready'/,
  'a failed OMS automatic recovery must release the shop profile through normal retry scheduling');
assert.match(workflow, /OMS automatic login recovery deferred for this shop profile/,
  'OMS Loading failures must yield this shop profile instead of looping indefinitely');
assert.match(workflow, /OMS_MANUAL_LOGIN_CLAIM_YIELD_MS \|\| 90_000/,
  'a missing per-shop OMS login must retain a bounded claim wait');
assert.match(workflow,
  /const claimYieldTimeoutMs = omsMode === 'per-shop'[\s\S]{0,180}residentCommandMode[\s\S]{0,180}externalEffectGuardEnabled[\s\S]{0,260}waitForLoginExit\([\s\S]{0,160}'oms-manual-login'[\s\S]{0,120}timeoutMs: manualLoginTimeoutMs \?\? claimYieldTimeoutMs/u,
  'a missing per-shop OMS login must yield a claimed order after the bounded wait');
assert.match(runner,
  /progress\.systemLogin\?\.system === 'oms'[\s\S]*progress\.systemLogin\?\.status === 'retry-ready'[\s\S]*OMS automatic login recovery \(\?:yielded the shared session\|deferred for this shop profile\)/,
  'an OMS profile yield must return to the retry queue instead of becoming a paused work order');
assert.match(runner,
  /const omsLoginYieldAfterExit[\s\S]*hasAnyExternalEffects[\s\S]*oms-login-required-retry-ready[\s\S]*preserve-per-shop-profile-and-yield-claim[\s\S]*externalActionsReplayed: false/u,
  'an interrupted per-shop OMS login must safely yield only before any external effect');
assert.match(postgresAdapter,
  /async hasAnyExternalEffects[\s\S]*FROM external_effects effect[\s\S]*ordinary_instance_id IS NOT DISTINCT FROM/u,
  'OMS login exit recovery must fence every external-effect status, including succeeded effects');
assert.match(interruptedPerShopOmsLoginRecoveryMigration,
  /status = 'failed'[\s\S]*systemLogin,system\}' = 'oms'[\s\S]*systemLogin,status\}' = 'retry-ready'[\s\S]*NOT EXISTS \([\s\S]*FROM external_effects effect/u,
  'migration 266 must target only failed OMS login yields with no external effects');
assert.match(interruptedPerShopOmsLoginRecoveryMigration,
  /oms-login-required-retry-ready[\s\S]*externalActionsReplayed', false[\s\S]*266_recover_interrupted_per_shop_oms_login\.sql/u,
  'migration 266 must preserve the per-shop profile and replay no business action');
assert.match(omsMarkVirtualizedRowRecoveryMigration,
  /11ee9965-0559-4989-8f94-8aa65bb962f4[\s\S]*d09edb54-37c3-41d8-8f90-ba743470a60e/u);
assert.match(omsMarkVirtualizedRowRecoveryMigration,
  /omsGridCells[\s\S]*cell->>'colId' = 'tags'[\s\S]*拆单可发/u);
assert.match(omsMarkVirtualizedRowRecoveryMigration,
  /effect\.ordinary_instance_id = instance\.id[\s\S]*effect\.status IN \('reserved', 'unknown'\)/u);
assert.match(omsMarkVirtualizedRowRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('succeeded', 'unknown'\)/u);
assert.match(omsMarkVirtualizedRowRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)[\s\S]*externalActionsReplayed', false/u);
assert.match(omsMarkVirtualizedRowRecoveryMigration,
  /267_recover_oms_mark_virtualized_row\.sql/u);
assert.match(relocatedAbnormalNetworkCompletionArchiveMigration,
  /3377695b-2b28-4b1c-b042-0a2b7787463d[\s\S]*90c4e1c6-ed04-4f35-9285-0b6ff7088582/u);
assert.match(relocatedAbnormalNetworkCompletionArchiveMigration,
  /pdd_shop_runtime_bindings[\s\S]*identityRelocatedAt[\s\S]*pddResolutionSubmission,recoveredFromCompletedPage/u);
assert.match(relocatedAbnormalNetworkCompletionArchiveMigration,
  /legacyEvidenceAccessed', false[\s\S]*legacyEvidenceDeleted', false[\s\S]*businessEffectsReplayed', false/u);
assert.match(relocatedAbnormalNetworkCompletionArchiveMigration,
  /effect\.status IN \('reserved', 'unknown'\)[\s\S]*runtime\.lease_expires_at > now\(\)/u);
assert.match(relocatedAbnormalNetworkCompletionArchiveMigration,
  /268_archive_relocated_abnormal_network_completion\.sql/u);
assert.match(supersededShopLevelInterventionReconciliationMigration,
  /intervention\.work_order_id IS NULL[\s\S]*intervention\.ordinary_instance_id IS NULL[\s\S]*created_at <= now\(\) - interval '48 hours'/u,
  'migration 269 must target only old shop-level interventions without order identity');
assert.match(supersededShopLevelInterventionReconciliationMigration,
  /sync_cursors cursor[\s\S]*cursor\.last_success_at > intervention\.created_at[\s\S]*cursor\.backlog_count, 0\) = 0[\s\S]*cursor\.last_error IS NULL/u,
  'migration 269 must require a later healthy shop synchronization');
assert.match(supersededShopLevelInterventionReconciliationMigration,
  /代发聚水潭-\(迅发\|品动工贸\|祺迦工贸\)[\s\S]*NOT EXISTS \([\s\S]*FROM work_orders work_order/u,
  'migration 269 must reconcile only explicitly expanded warehouses and reject a matching active order');
assert.doesNotMatch(supersededShopLevelInterventionReconciliationMigration,
  /久伴体育/u,
  'migration 269 must not name or resolve an explicitly prohibited warehouse');
assert.match(supersededShopLevelInterventionReconciliationMigration,
  /workOrderIdentityPresent', false[\s\S]*businessActionsReplayed', false[\s\S]*269_reconcile_superseded_shop_level_interventions\.sql/u,
  'migration 269 must audit that it replayed no business action');
assert.match(liveRuntimeAudit,
  /const verificationBlockedRefundWaits = overdueRefundWaits\.filter[\s\S]*activePddVerificationShopIds\.has\(refund\.shopId\)/u,
  'the live audit must identify refund waits blocked by an active PDD challenge');
assert.match(liveRuntimeAudit,
  /unexplainedOverdueRefundWaits\.length \? \['overdue-return-refund-waits'\][\s\S]*verification-blocked-refund-waits/u,
  'only unexplained overdue refund waits may become a hard issue');
assert.match(omsLoginDeferredRecoveryMigration, /oms-login-deferred-pause-recovered/);
assert.match(omsLoginDeferredRecoveryMigration, /systemLogin,status/);
assert.match(omsLoginDeferredRecoveryMigration, /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(optionalRecallEvidenceRecoveryMigration, /optional-recall-evidence-pause-recovered/);
assert.match(optionalRecallEvidenceRecoveryMigration, /ordinaryEvidenceUploadRecovery,status/);
assert.match(optionalRecallEvidenceRecoveryMigration, /ordinaryScenarioDecision,pdd,option.*已进行召回/);
assert.match(optionalRecallEvidenceRecoveryMigration, /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(optionalRecallEvidenceRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.ordinary_instance_id IS NOT DISTINCT FROM work_order\.current_ordinary_instance_id[\s\S]*effect\.status IN \('succeeded', 'unknown'\)/);
assert.match(optionalSubjectiveInterceptEvidenceRecoveryMigration,
  /optional-subjective-intercept-evidence-pause-recovered/);
assert.match(optionalSubjectiveInterceptEvidenceRecoveryMigration,
  /scenario_code = 'in-transit-refund'/);
assert.match(optionalSubjectiveInterceptEvidenceRecoveryMigration,
  /pddResolutionFlow,flowCode.*subjective-intercept/);
assert.match(optionalSubjectiveInterceptEvidenceRecoveryMigration,
  /pddResolutionFlow,secondaryReason.*主观原因不想要/);
assert.match(optionalSubjectiveInterceptEvidenceRecoveryMigration,
  /pddResolutionFlow,tertiaryOutcome.*尝试拦截快递/);
assert.match(optionalSubjectiveInterceptEvidenceRecoveryMigration,
  /pddEvidenceUpload,diagnostics,authorizationFailure,errorCode.*48143/);
assert.match(optionalSubjectiveInterceptEvidenceRecoveryMigration,
  /pddResolutionSubmission,submitAttemptCount/);
assert.match(optionalSubjectiveInterceptEvidenceRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('succeeded', 'unknown'\)/);
assert.match(optionalEvidenceFollowupRecoveryMigration,
  /optional-evidence-followup-pause-recovered/);
assert.match(optionalEvidenceFollowupRecoveryMigration,
  /subjective-intercept-top-level-outcome/);
assert.match(optionalEvidenceFollowupRecoveryMigration,
  /completion-query-render-timeout/);
assert.match(optionalEvidenceFollowupRecoveryMigration,
  /completion-query-input-timeout/);
assert.match(optionalEvidenceFollowupRecoveryMigration,
  /pddResolutionOutcomeMismatch,completedOutcome/);
assert.match(optionalEvidenceFollowupRecoveryMigration,
  /拼多多普通工单完结查询渲染刷新后等待 30000 毫秒仍未出现有效结果/);
assert.match(exactEmptyResultRecoveryMigration, /exact-empty-result-pause-recovered/);
assert.match(exactEmptyResultRecoveryMigration,
  /verify-exact-query-zero-result-before-completion/);
assert.match(exactEmptyResultRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(createdTimeLowerBoundRecoveryMigration,
  /created-time-lower-bound-pause-recovered/);
assert.match(createdTimeLowerBoundRecoveryMigration,
  /wait-until-first-observed-age-exceeds-48-hours/);
assert.match(createdTimeLowerBoundRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(subjectiveRefundOutcomeAliasRecoveryMigration,
  /subjective-refund-outcome-alias-pause-recovered/);
assert.match(subjectiveRefundOutcomeAliasRecoveryMigration,
  /pddResolutionFlow,flowCode.*subjective-intercept/);
assert.match(subjectiveRefundOutcomeAliasRecoveryMigration,
  /pddResolutionOutcomeMismatch,completedOutcome/);
assert.match(subjectiveRefundOutcomeAliasRecoveryMigration,
  /pddResolutionDecision,outcome/);
assert.match(subjectiveRefundOutcomeAliasRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(subjectiveRefundOutcomeAliasRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('succeeded', 'unknown'\)/);
assert.doesNotMatch(workflow,
  /acceptsAnyReadableWarehouse/,
  'extended ordinary scenarios must never turn any readable OMS warehouse into an allowed warehouse');
assert.match(workflow,
  /const inspectOmsWarehouseScope = \(warehouse\)[\s\S]*'out-of-scope'[\s\S]*matchedWarehouses/,
  'all business flows must share one strict OMS warehouse scope classifier');
assert.match(workflow,
  /const omsWarehouseKeywords = \[[\s\S]{0,220}迅发[\s\S]{0,100}品动工贸[\s\S]{0,100}祺迦工贸/u,
  'OMS parsing must recognize every newly approved warehouse');
assert.match(workflow,
  /const warehouseCategories = \[[\s\S]{0,900}xunfa[\s\S]{0,160}pindong[\s\S]{0,160}qijia/u,
  'the shared mutation guard must allow the three new warehouse categories');
assert.match(workflow,
  /const ensureOmsWarehouseMutationAllowed = async[\s\S]*oms-warehouse-out-of-scope[\s\S]*blockedOperation/,
  'a second scope guard must block stale confirmed warehouse state before external mutations');
assert.match(workflow,
  /const hasCompleteScenarioOmsAnalysis =[\s\S]*requiresWarehouseForMutation[\s\S]*analysis\.warehouseStatus === 'confirmed'/,
  'an unshipped abnormal-network order must prove an allowed warehouse before OMS allocation');
assert.match(workflow,
  /const abnormalNetworkRequiresWarehouse =[\s\S]*if \(scenarioCode === 'abnormal-network-warning' && !abnormalNetworkRequiresWarehouse\)[\s\S]*if \(scenarioCode !== 'abnormal-network-warning'\)/u,
  'abnormal-network orders must read warehouse only when allocation mutates OMS and skip unrelated mark parsing');
assert.match(workflow,
  /runOmsManualAllocation = async[\s\S]{0,700}ensureOmsWarehouseMutationAllowed\(targetPage, orderNumber, 'OMS 配货操作'\)/u);
assert.match(workflow,
  /runOmsReissueCreationUnlocked = async[\s\S]{0,300}ensureOmsWarehouseMutationAllowed\(targetPage, orderNumber, 'OMS 补发操作'\)/u);
assert.match(workflow,
  /runOmsReissueCreation = async[\s\S]{0,500}runOmsReissueCreationUnlocked/u,
  'the OMS reissue lock wrapper must delegate to the warehouse-guarded implementation');
assert.match(workflow,
  /runTmsWorkflow = async[\s\S]{0,1800}ensureOmsWarehouseMutationAllowed\(targetPage, orderNumber, 'TMS 建单或拼多多后续提交'\)/u);
assert.match(workflow,
  /allowReadableUnmappedValues = allowConditionalScenario[\s\S]*fallback-intercept-return/);
assert.match(readableWarehouseRecoveryMigration, /oms-warehouse-out-of-scope/);
assert.match(readableWarehouseRecoveryMigration, /readable-warehouse-scope-pause-recovered/);
assert.match(readableWarehouseRecoveryMigration,
  /effect\.effect_type IN \('tms-create', 'pdd-submit'\)[\s\S]*effect\.status IN \('succeeded', 'unknown'\)/);
assert.match(workflow,
  /identifyExistingTmsTicket[\s\S]*allowReadableUnmappedValues = false[\s\S]*expectedWarehouse\.normalized\.includes/);
assert.match(workflow,
  /existingTmsIdentityFields[\s\S]*运单号[\s\S]*发货仓库[\s\S]*责任快递/u);
assert.match(workflow,
  /findDeepValue\(record, \[[\s\S]*trackingNumber[\s\S]*identityFields\.tracking/);
assert.match(workflow,
  /identifyExistingTmsTicket\(rowSelection, orderNumber, progress, \{[\s\S]*routingDecision\.precedence === 'fallback-intercept-return'/);
assert.match(readableTmsDuplicateRecoveryMigration, /tms-duplicate-check/);
assert.match(readableTmsDuplicateRecoveryMigration, /readable-tms-existing-ticket-pause-recovered/);
assert.match(completedReturnTmsDecisionRecoveryMigration,
  /completed-return-tms-decision-pause-recovered/u);
assert.match(completedReturnTmsDecisionRecoveryMigration,
  /instance\.identity_status = 'verified'[\s\S]*candidateCount[\s\S]*::integer = 1/u);
assert.match(completedReturnTmsDecisionRecoveryMigration,
  /expectedProblemType[\s\S]*= '丢件'[\s\S]*actualTaskStatus[\s\S]*任务状态/u);
assert.match(completedReturnTmsDecisionRecoveryMigration,
  /交易号[\s\S]*external_order_number[\s\S]*salesOrderCode[\s\S]*运单号[\s\S]*发货仓库[\s\S]*责任快递/u);
assert.match(completedReturnTmsDecisionRecoveryMigration,
  /已在退回\(的\)\?路上\|已是退回件/u);
assert.match(completedReturnTmsDecisionRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)[\s\S]*effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status = 'succeeded'/u);
assert.match(completedReturnTmsDecisionRecoveryMigration,
  /effect\.effect_type = 'evidence-upload'[\s\S]*effect\.status IN \('failed', 'reserved', 'unknown'\)/u);
assert.match(completedReturnTmsDecisionRecoveryMigration,
  /runtime\.lease_token IS NOT NULL[\s\S]*runtime\.lease_expires_at > now\(\)/u);
assert.match(returnRefundScanRestoreMigration,
  /return-refund-scan-enabled[\s\S]*'true'::jsonb[\s\S]*return-refund-scan-restored/u);
assert.match(returnRefundScanRestoreMigration,
  /cursorReset'[\s\S]*false[\s\S]*externalSubmissionStarted'[\s\S]*false/u,
  'restoring discovery must preserve the durable cursor and start no external submission');
assert.match(returnRefundScanRestoreMigration,
  /next_refund_scan_at = least\(schedule\.next_refund_scan_at, now\(\)\)/u,
  'enabled shops must become immediately eligible for a refund scan');
assert.doesNotMatch(returnRefundScanRestoreMigration,
  /UPDATE\s+(?:return_refunds|work_orders|external_effects)/u,
  'restoring discovery must not mutate business records or external effects');
assert.match(safeOrdinaryParserAndBodyTimeoutRecoveryMigration,
  /reparse-labeled-courier-phone[\s\S]*retry-read-only-body-render/u);
assert.match(safeOrdinaryParserAndBodyTimeoutRecoveryMigration,
  /binding\.binding_token::text[\s\S]*pddIdentityBindingToken/u);
assert.match(safeOrdinaryParserAndBodyTimeoutRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)[\s\S]*effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status = 'succeeded'/u);
assert.match(safeOrdinaryParserAndBodyTimeoutRecoveryMigration,
  /manual_review_reason[\s\S]*NOT LIKE '%48143%'/u);
assert.match(workflow, /tmsExistingTicketSuborderComparison/);
assert.match(workflow, /Number\(candidateCount\) === 1[\s\S]*omsOrderDistinct[\s\S]*trackingDistinct/,
  'only one explicitly distinct OMS suborder may bypass an unrelated TMS ticket');
assert.match(workflow, /existing\.status === 'unrelated'[\s\S]*tms-unrelated-existing-ticket-ignored/);
assert.match(distinctTmsSuborderRecoveryMigration, /distinct-tms-suborder-pause-recovered/);
assert.match(distinctTmsSuborderRecoveryMigration, /candidateCount.*\)::integer[\s\S]*= 1/);
assert.match(distinctTmsSuborderRecoveryMigration,
  /effect\.effect_type IN \('tms-create', 'pdd-submit'\)[\s\S]*effect\.status IN \('reserved', 'succeeded', 'unknown'\)/);
assert.match(crossShopAbsentPendingRecoveryMigration, /confirmationMethod' = 'absent-from-pending-list'/);
assert.match(crossShopAbsentPendingRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('reserved', 'succeeded', 'unknown'\)/,
  'cross-shop archive recovery must not retry after a PDD submission may already have happened');
assert.match(crossShopAbsentPendingRecoveryMigration, /pdd-identity-mismatch-retry-ready/);
assert.match(workflow, /退回包裹\|包裹\.\{0,12\}退回/);
assert.match(legacyTmsInterceptRemarkRecoveryMigration, /legacy-tms-intercept-remark-pause-recovered/);
assert.match(legacyTmsInterceptRemarkRecoveryMigration, /tmsEvidenceScreenshot,status/);
assert.match(runner,
  /拼多多普通工单完结查询渲染刷新后等待 \\d\+ 毫秒仍未出现有效结果/,
  'a bounded completion-query render timeout must return to the transient retry queue');
assert.match(runner, /locator\\\.fill: Timeout\[\\s\\S\]\*请输入订单编号/,
  'a missing completion-query input must return to the transient retry queue');
assert.doesNotMatch(workflow, /const ensureOmsLoginUnlocked = async[\s\S]{0,300}while \(true\)/,
  'OMS login recovery must not hold the cross-shop lock in an unbounded loop');
assert.match(workflow, /confirmedNotApplied: true/);
assert.match(workflow, /notAppliedRetryAuthorizedAt/);
assert.match(workflow, /flag: 'wx'/);
assert.match(workflow, /oms-shared-session-waiting/);
assert.match(workflow, /oms-order-analysis:\$\{orderNumber\}/);
assert.match(workflow, /oms-warehouse-out-of-scope/);
assert.match(workflow, /不在业务处理范围/);
assert.match(workflow, /nonRetryableManualReviewStages[\s\S]*'oms-warehouse-out-of-scope'/);
assert.match(workflow, /reservation\.alreadySucceeded/);
assert.match(workflow, /selectDetectedPddShopName/);
assert.match(workflow,
  /collectRevealedPddShopIdentity[\s\S]*\.mms-header__user-info[\s\S]*\.user-name-name[\s\S]*hover\([\s\S]*click\(/,
  'PDD identity detection must reveal the account area before accepting a masked shop name');
assert.match(workflow, /status: 'detected'/);
assert.match(workflow, /actualShopName: detected\.name/);
assert.doesNotMatch(workflow, /已禁止领取工单/);
assert.match(workflow, /identityBindingMatchesLoginRequest/);
assert.match(workflow, /ordinary-completion-reconciled-before-submit/);
assert.match(workflow,
  /TMS_OMS_QUERY_RETRY_AFTER_MS \|\| '120000'[\s\S]*tmsOmsQueryRetryAfterMs/,
  'transient TMS OMS query retries must use the bounded configurable delay');
assert.match(workflow,
  /Math\.min\([\s\S]{0,80}120_000,[\s\S]{0,80}emptyQueuePollMs/,
  'transient TMS OMS query retries must stay within the two-minute upper bound');
assert.match(workflow,
  /fillReadyOmsOrderQueryInput[\s\S]*input\.isEditable\(\)[\s\S]*findOmsOrderQueryInput/,
  'OMS order queries must reacquire the SPA input until it becomes editable');
assert.match(workflow,
  /const queryOmsOrderRow[\s\S]*?for \(let attempt = 1; attempt <= 2; attempt\+\+\)[\s\S]*?fillReadyOmsOrderQueryInput[\s\S]*?step: 'oms-order-query-refreshing'[\s\S]*?targetPage\.reload[\s\S]*?new LogisticsRetryRequiredError/,
  'every shared OMS row query must wait, refresh once, and return a transient queue signal');
assert.match(workflow,
  /const queryOmsReissueOrder[\s\S]*?for \(let attempt = 1; attempt <= 2; attempt\+\+\)[\s\S]*?fillReadyOmsOrderQueryInput[\s\S]*?step: 'oms-reissue-query-refreshing'[\s\S]*?targetPage\.reload/,
  'OMS reissue verification must wait and refresh once before marking the result unconfirmed');
assert.doesNotMatch(workflow,
  /const queryOmsOrderRow[\s\S]*?await input\.fill\(orderNumber\)[\s\S]*?const closeOmsManualAllocationDialog/,
  'shared OMS row queries must never fill a merely mounted input directly');
assert.match(workflow,
  /for \(let pass = 1; pass <= 2 && !orderResult; pass\+\+\)[\s\S]*targetPage\.reload/,
  'OMS order queries must wait once and refresh once before returning to the queue');
assert.match(workflow,
  /for \(let attempt = 1; attempt <= 2 && !queryOutcome; attempt\+\+\)[\s\S]*tms-oms-query-transient[\s\S]*new LogisticsRetryRequiredError/,
  'TMS OMS queries must retry transient loading text and then return to the queue');
assert.match(workflow, /isTransientTmsOmsQueryMessage\(queryMessage\)/,
  'TMS query text must use the tested transient-state classifier');
assert.match(workflow, /class PddWorkOrderAlreadyCompletedError extends Error/,
  'a PDD detail completed while waiting for submit must have a non-retry terminal signal');
assert.match(workflow,
  /ordinary-completion-reconciled-while-waiting-submit[\s\S]*recoveredFromCompletedPage: true/,
  'extended ordinary work orders completed while waiting for submit must archive without another click');
assert.match(workflow,
  /pdd-resolution-completed-while-waiting-submit[\s\S]*status: 'completed-before-submit'/,
  'standard work orders completed while waiting for submit must archive without manual review');
assert.match(workflow, /recoveredFromCompletedPage: Boolean\(state\?\.recoveredFromCompletedPage\)/,
  'an already-completed PDD page must be recorded as assisted completion rather than pure automation');
assert.match(dataBackend,
  /pddResolutionSubmission'->>'recoveredFromCompletedPage'[\s\S]*lastCompletedOrder'->>'recoveredFromCompletedPage'[\s\S]*completionArchive'->>'recoveredFromCompletedPage'[\s\S]*false[\s\S]*\) = false/,
  'reconciled completed pages must be excluded from the pure-automation metric');
assert.match(workflow, /identityBindingRevokedReason = 'new-login-request'/);
assert.match(runner, /PDD_LOGIN_REQUESTED_AT: shop\.loginRequestedAt/);
assert.match(postgresAdapter,
  /'operator-verification-force-cleared',[\s\S]*'human-verification-required',[\s\S]*'manual-login-required'/,
  'an expired verification or login lease must resume before unrelated queued work');
assert.match(runner, /synchronizeDetectedPddShopIdentity/);
assert.match(runner, /const markerNameMasked = isMaskedDetectedPddShopName\(markerBinding\.expectedShopName\)/);
assert.match(runner, /markerNameMasked \|\| expectedCanonical === markerCanonical/,
  'a masked local marker may restore only when all persisted identity evidence matches');
assert.match(runner, /maskedPddShopName = isMaskedDetectedPddShopName\(actualShopName\)/,
  'masked PDD shop names must not replace or conflict with a confirmed profile binding');
assert.match(workflow, /const detectedShopNameMasked = isMaskedPddShopIdentityName\(detected\.name\)/);
assert.match(workflow, /markerBindingShopName = detectedShopNameMasked[\s\S]*existingBindingShopName \|\| configuredBindingShopName/,
  'masked PDD shop names must preserve the last confirmed unmasked browser identity');
assert.match(workflow, /lastUnmaskedIdentityObservation = \{[\s\S]*actualShopName: detected\.name[\s\S]*detectedAt: checkedAt/,
  'the browser profile must retain the latest full shop identity across worker restarts');
assert.match(workflow, /delete nextMarker\.lastUnmaskedIdentityObservation/,
  'an explicit new login request must clear the previous login identity observation');
assert.match(runner, /persistedMarkerIdentityConflict/);
assert.match(runner, /browser-profile-last-unmasked-observation/,
  'a persisted full-name conflict must revoke the binding after a worker restart');
assert.match(runner,
  /dynamicPddShopBinding[\s\S]{0,120}\? Boolean\(currentPddIdentityBindingToken\)[\s\S]{0,120}: identitySynchronized && identityFromCurrentRunner/,
  'an authenticated dynamic profile must not become ready without a confirmed identity token');
assert.match(runner,
  /WORKFLOW_FOREGROUND_MODE: slotKind === 'login' \|\| assignmentKind === 'login'[\s\S]{0,100}\? 'manual-only'/,
  'a requested PDD login may take focus without granting later business pages foreground access');
assert.match(runner, /shop-identity-synchronized/);
assert.match(workflow, /PDD_DYNAMIC_SHOP_BINDING/);
assert.match(workflow, /localStorage\.getItem\('new_userinfo'\)/,
  'PDD identity capture must read the stable mall identity from the authenticated session');
assert.match(workflow, /mallId: mallIdentity\?\.mallId \|\| null/,
  'PDD progress and profile markers must retain the stable mall id');
assert.match(runner, /const pddIdentityKey = \(\{ mallId, actualShopName \}\)/);
assert.match(runner, /\? `mall:\$\{normalizedMallId\}`/,
  'runtime identity uniqueness must prefer mall id over a possibly duplicated shop name');
assert.match(runner, /confirmedMallMismatch[\s\S]*persistPddIdentityMismatch/,
  'a same-name login with the wrong mall id must be blocked before claiming work');
assert.match(runner, /configuredNameMismatch[\s\S]*persistPddIdentityMismatch/,
  'a different account name must be blocked even outside an explicit login request');
assert.match(pddMallIdentityMigration, /ADD COLUMN IF NOT EXISTS mall_id text[\s\S]*idx_pdd_shop_runtime_bindings_mall_id/,
  'the mall identity schema must be portable to existing databases');
assert.match(runner, /pddMallId: currentPddIdentityMetadata\.mallId \|\| null/,
  'new ordinary and return-refund records must persist the stable mall id');
assert.match(postgresAdapter, /async bindLegacyPendingOrdersToIdentity\(\{ shopId, identityBindingToken, actualShopName, mallId = null \}\)/);
assert.match(postgresAdapter, /refund\.evidence->>'pddMallId'[\s\S]*coalesce\(refund\.evidence->>'pddIdentityBindingToken', ''\) = ''/,
  'cross-shop legacy relocation must require mall-id proof unless the record never had a binding');
assert.match(defenceShopIdentityMigration, /PANAPOPO防护用品官方旗舰店[\s\S]*identityRelocatedAt/,
  'the fifth shop recovery must preserve exact historical shop-name evidence');
assert.match(runner, /pdd-workflow:dynamic-shop-binding/);
assert.match(runner, /pdd-identity-duplicate/);
assert.match(runner, /ensureDynamicPddShopBindingReady/);
assert.match(runner,
  /const keepsIdentityCorrectionBrowserOpen = persistentSlotSession \|\| residentBrowser[\s\S]{0,500}if \(!persistentSlotSession && !residentBrowser && assignmentKind !== 'login'\)/,
  'a resident shop with the wrong PDD identity must keep its labeled browser open for correction');
assert.match(runner, /const identityBindingWaitMs = Math\.max\(5 \* 60_000, sessionMaxMs\)/,
  'PDD identity login waiting must follow the configured login session duration');
assert.match(runner, /const deadline = Date\.now\(\) \+ identityBindingWaitMs/,
  'PDD identity detection must not close a 15-minute login session after five minutes');
assert.match(runner, /refresh-pdd-identity/);
assert.match(runner, /const identityRefreshHeartbeat = setInterval\([\s\S]*heartbeatIntervalMs\)/);
assert.match(runner, /clearInterval\(identityRefreshHeartbeat\)/);
assert.match(runner, /bindLegacyPendingOrdersToIdentity/);
assert.match(runner, /queue-identity-blocked/);
assert.match(runner, /queue-claim-blocked/);
assert.match(runner, /ordinaryEligibility\.active_claim > 0/);
assert.match(runner, /discovery: 'deferred-until-active-lease-expires'/);
assert.match(runner,
  /const directRefundExecutionSession = boundedSlotSession && assignmentKind === 'refund-execution'/);
assert.match(runner,
  /claim = returnRefundOnly \|\| directRefundExecutionSession[\s\S]{0,500}scenarioCodes: \['return-refund'\][\s\S]{0,500}: await claimEligibleOrdinary\(\)/,
  'a refund-execution session must claim a persisted refund before any ordinary discovery');
assert.match(runner,
  /if \(returnRefundOnly \|\| directRefundExecutionSession\) \{[\s\S]*'return-refund-queue-empty'[\s\S]*return false;[\s\S]*const ordinaryEligibility/,
  'an empty refund-execution assignment must yield without running an ordinary discovery scan');
assert.match(runner, /discovery: 'deferred-until-claim-block-clears'/);
assert.match(runner, /scenarioCodes: \['return-refund'\]/);
assert.match(postgresAdapter, /async bindLegacyPendingOrdersToIdentity/);
assert.match(
  postgresAdapter,
  /ordinaryRelocationCandidates[\s\S]*target\.external_order_number = work_order\.external_order_number[\s\S]*target\.scenario_code IS DISTINCT FROM 'return-refund'/,
  'a return-refund for the same sale order must not block ordinary work-order relocation',
);
assert.match(postgresAdapter, /ORDER BY CASE[\s\S]*work_order\.current_step IN \([\s\S]*'operator-retry-requested'[\s\S]*'operator-resume-requested'[\s\S]*'verification-recheck-requested'[\s\S]*'operator-verification-force-cleared'[\s\S]*priority_effect\.status IN \('reserved','unknown'\)[\s\S]*THEN 0[\s\S]*return-refund-terminal-reconciliation-ready'[\s\S]*THEN 1[\s\S]*ELSE 2/,
  'explicit operator retries must be claimed before the automatic backlog');
assert.match(postgresAdapter, /legacy-work-order-identity-bound/);
assert.match(postgresAdapter, /work_order\.payload->'pddShopIdentity'->>'mallId'/,
  'identity recovery must accept the exact mall id retained in a workflow page snapshot');
assert.match(postgresAdapter, /work_order\.payload->'pddShopIdentity'->>'actualShopName'/,
  'identity recovery must accept the exact shop name retained in a workflow page snapshot');
assert.match(postgresAdapter, /async getOrdinaryQueueEligibility/);
assert.match(postgresAdapter, /runtime\.current_work_order_id IS NOT NULL[\s\S]*runtime\.lease_expires_at > now\(\)[\s\S]*AS active_claim/);
assert.match(postgresAdapter, /AS active_claim_expires_at/);
assert.match(postgresAdapter,
  /async getQueueSnapshot[\s\S]*AS due[\s\S]*AS scheduled[\s\S]*AS held[\s\S]*AS "nextScheduledAt"/,
  'queue snapshots must distinguish due work from scheduled retries and recovery-held records');
assert.match(runner,
  /const queue = await repository\.getQueueSnapshot\(shopId\)[\s\S]{0,500}queue\.scheduled > 0[\s\S]{0,160}'queue-waiting'/,
  'an ordinary queue with future retries must not report queue-empty');
assert.match(runner, /'return-refund-queue-waiting'/,
  'a return-refund queue with future retries must not report queue-empty');
assert.match(workflow, /pddShopIdentity: current\.pddShopIdentity/);
assert.match(workflow, /refresh-pdd-identity/);
assert.match(workflow,
  /updateManagedBrowserTitle[\s\S]*expectedAccountLabel[\s\S]*currentAccountLabel/,
  'managed browser titles must identify both the expected and current account');
assert.match(workflow, /const shopLabel = `\$\{accountLabel\}（\$\{shopId\}｜\$\{identityLabel\}）`/,
  'managed browser titles must include the unique shop id and mall id');
assert.match(workflow,
  /const pddIdentityMatchesExpected = !configuredIdentity \|\| \([\s\S]{0,360}progress\.pddShopIdentity\?\.status === 'detected'[\s\S]{0,220}observedIdentity === configuredIdentity[\s\S]{0,220}!isMaskedPddShopIdentityName\(observedShopName\)[\s\S]{0,260}\) && pddIdentityMatchesExpected/,
  'a wrong or masked PDD account must never overwrite the last-known-good login snapshot');
assert.match(workflow,
  /status === 'authenticated'[\s\S]*isMaskedPddShopIdentityName\(observedShopName\)[\s\S]*titleStatus = 'identity-mismatch'/,
  'an authenticated PDD session must still label a wrong or unresolved shop identity');
assert.match(shopsView, /const pddLogin = pddLoginState\(shop\)/,
  'shop management must derive PDD login state from both authentication and shop identity');
assert.match(shopsView, /拼多多登录[\s\S]*pddLogin\.label[\s\S]*pddLogin\.detail/,
  'shop management must show which shop is logged out or logged into the wrong account');
assert.match(shopsView, /OMS \/ TMS 登录[\s\S]*OMS 使用本店独立账号和 Profile/,
  'shop management must explain that OMS authentication is isolated per shop');
assert.match(shopsView, /system-login[\s\S]*JSON\.stringify\(\{ system \}\)/,
  'shop management must request a system-specific login without resetting PDD identity');
assert.match(dataBackend,
  /async requestShopSystemLogin[\s\S]*work_order_id IS NULL[\s\S]*command_type = 'focus-system-login'[\s\S]*payload->>'system'/,
  'system login commands must be shop-scoped and deduplicated per system');
assert.match(apiMain, /shops\/:shopId\/system-login[\s\S]*requestShopSystemLogin/,
  'the owner API must expose the system-specific login command');
assert.match(runner,
  /const authentication = workflowAuthenticationState\(progress\)[\s\S]*authenticationSystem: authentication\.blocked[\s\S]*authenticationStatus:/,
  'every heartbeat must preserve the actual blocked system and authentication status');
assert.match(runner, /currentPddIdentityMetadata/);
assert.match(runner, /currentPddIdentityValidatedAt/);
assert.match(runner,
  /currentPddIdentityBindingToken[\s\S]{0,120}Number\.isFinite\(currentPddIdentityValidatedAt\)[\s\S]{0,120}currentPddIdentityValidatedAt >= runnerStartedAt[\s\S]{0,120}ensureResidentWorkflowForReturnRefund/,
  'a restored binding must be revalidated in the current browser before any work is claimed');
assert.match(runner, /identityBelongsToCurrentLogin/);
assert.match(runner, /identityFromCurrentRunner/);
assert.match(
  runner,
  /pddHealth\.status === 'authenticated'[\s\S]{0,180}identityBelongsToCurrentLogin[\s\S]{0,180}dynamicPddShopBinding[\s\S]{0,120}Boolean\(currentPddIdentityBindingToken\)/,
  'an authenticated dynamic browser profile must retain a confirmed binding before becoming ready',
);
assert.match(runner, /detectedAt < runnerStartedAt/);
assert.match(runner, /identity\.loginRequestedAt[\s\S]*shop\.loginRequestedAt/);
assert.match(runner, /pdd-duplicate-shop-login/);
assert.match(runner, /onboardingStatus = 'waiting-login'/);
assert.match(runner, /PDD_DUPLICATE_SHOP_ACTIVE_WORK_ORDER/);
assert.match(scannedIdentityMigration, /DROP INDEX IF EXISTS idx_shops_expected_name_unique/);
assert.match(scannedIdentityMigration, /CREATE INDEX IF NOT EXISTS idx_shops_expected_name/);
assert.match(dataBackend, /UPDATE shop_identity_bindings[\s\S]*status = 'revoked'/);
assert.match(workflow, /effectType: 'tms-create'/);
assert.match(workflow, /TMS_CREATED_ROW_VISIBILITY_TIMEOUT_MS \|\| 30_000/);
assert.match(workflow, /TMS_NAVIGATION_TIMEOUT_MS \|\| 30_000/);
assert.match(workflow, /open-tms-customer-registration-direct-/);
assert.match(workflow, /waitForTmsCustomerRegistration/);
assert.match(workflow,
  /await responsePromise;[\s\S]{0,500}return \{ exactRows, count: await exactRows\.count\(\), payload: null \}/,
  'TMS exact-row lookup must not deserialize the deep list API payload');
assert.match(workflow,
  /The rendered exact row is the authoritative TMS record[\s\S]{0,350}const record = \{\};/,
  'TMS duplicate correlation must use the visible exact row before any API payload');
assert.match(workflow, /errorStack: error\?\.stack/,
  'workflow diagnostics must retain a bounded error stack for technical failures');
assert.match(workflow, /for \(let attempt = 1; !logisticsWorkOrders && attempt <= 2; attempt\+\+\)/);
assert.match(tmsMenuNavigationRecoveryMigration, /= 'TMS 未找到“物流快递工单”菜单'/);
assert.match(tmsMenuNavigationRecoveryMigration, /tms-menu-navigation-retry-ready/);
assert.doesNotMatch(tmsMenuNavigationRecoveryMigration, /查询到 2 个订单/);
assert.match(pddDetailClickRecoveryMigration, /transient-unblocked-click-timeout/);
assert.match(pddDetailClickRecoveryMigration, /Timeout 1500ms exceeded/);
assert.doesNotMatch(pddDetailClickRecoveryMigration, /查询到 2 个订单/);
assert.doesNotMatch(pddDetailClickRecoveryMigration, /48143/);
assert.match(omsDetachedRowRecoveryMigration, /ag-grid-detached-order-cell/);
assert.match(omsDetachedRowRecoveryMigration, /= 'OMS 查询结果未找到订单所在行'/);
assert.doesNotMatch(omsDetachedRowRecoveryMigration, /查询到 2 个订单/);
assert.doesNotMatch(omsDetachedRowRecoveryMigration, /48143/);
assert.match(workflow, /step: 'tms-created-row-waiting'/);
assert.match(workflow, /knownCreatedTicket[\s\S]*Date\.now\(\) >= deadline/);
assert.match(workflow, /step: 'tms-created-row-refreshing'/);
assert.match(workflow, /TMS_CREATED_ROW_NOT_VISIBLE/);
assert.doesNotMatch(
  workflow.slice(
    workflow.indexOf('const runTmsWorkflow = async'),
    workflow.indexOf('const readPddResolutionState = async'),
  ),
  /pauseForManualReview\(targetPage, 'tms-created-row-verification'/,
  'an API-created TMS ticket must return to the bounded automatic retry queue before manual review',
);
assert.match(workflow, /close-stale-tms-drawer/);
assert.match(workflow, /findVisibleOmsOrderCell[\s\S]*ag-center-cols-container/);
assert.match(workflow, /const findVisibleOmsOrderRow = async/);
assert.match(workflow, /Re-acquire both locators in the same polling iteration/);
assert.match(workflow, /self::tr or @role="row"[\s\S]*ag-row/);
assert.match(workflow, /ag-pinned-left-cols-container[\s\S]*row-index/);
assert.match(workflow, /oms-query-login-recovering/);
assert.match(workflow, /nestedMenus[\s\S]*更多操作/);
assert.match(workflow, /omsOrderStatusHasPassedAllocation/);
assert.match(workflow, /getByRole\('button', \{ name: \/\^更多操作\//);
assert.match(workflow, /hasRecallStatusStep[\s\S]*'已进行召回'[\s\S]*'recall-status'/);
assert.match(workflow, /isPddRecallTransitionComplete/);
assert.match(tmsCreatedRowRecoveryMigration, /tms-created-row-recovery-ready/);
assert.match(tmsCreatedRowRecoveryMigration, /effect\.effect_type = 'tms-create'[\s\S]*effect\.status = 'succeeded'/);
assert.match(reconciledPddRemarkRecoveryMigration, /pdd-order-remark-reconciliation-continuation/);
assert.match(reconciledPddRemarkRecoveryMigration, /command\.command_type = 'force-clear-verification'/);
assert.match(workflow, /effectType: 'pdd-submit'/);
assert.match(workflow, /addPddOrderRemark/);
assert.match(workflow, /inspectPddOrderRemark/);
assert.match(workflow, /const reconciledRemark = observation\.state === 'confirmed'[\s\S]*status: 'saved'/);
assert.match(workflow, /effectType: 'pdd-note'/);
assert.match(workflow, /effectType: 'oms-manual-allocation'/);
assert.match(workflow, /const ensureOmsOrderManagementPage = async/);
assert.match(
  workflow,
  /const analyzeOmsOrderUnlocked[\s\S]*?ensureOmsOrderManagementPage\(targetPage, browserContext, \{\s*maxAttempts: 2,\s*timeoutMs: 30_000,\s*\}\)/,
  'initial OMS analysis must use the shared bounded order-management render recovery',
);
assert.doesNotMatch(
  workflow.slice(
    workflow.indexOf('const analyzeOmsOrderUnlocked'),
    workflow.indexOf('const analyzeOmsOrder = async'),
  ),
  /const findOmsOrderInput|Date\.now\(\) \+ 45000|OMS 订单管理页面未渲染订单查询输入框/,
  'initial OMS analysis must not retain the old one-shot order-page navigation',
);
assert.match(
  workflow,
  /const ensureOmsOrderManagementPage[\s\S]*?if \(attempt < maxAttempts\) \{[\s\S]*?step: 'oms-order-management-render-recovering'[\s\S]*?targetPage\.reload\(\{\s*waitUntil: 'domcontentloaded',\s*timeout: 30_000/,
  'OMS order-page recovery must wait once, refresh once, then retry the navigation',
);
assert.match(
  workflow,
  /const reopenPddDetailForResolution[\s\S]*?isPddDetailUrl\(targetPage\.url\(\)\)[\s\S]*?ensurePddResolutionDetailReady\([\s\S]*?allowUnresolved: true,[\s\S]*?settleMs: pddRenderWaitMs[\s\S]*?pddResolutionDetailReuse[\s\S]*?return targetPage/,
  'post-OMS/TMS resolution must wait 30 seconds and refresh the saved detail once before reopening it through the list',
);
assert.match(omsOrderManagementRenderRecoveryMigration,
  /OMS 订单管理页面未渲染订单查询输入框/);
assert.match(omsOrderManagementRenderRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(omsOrderManagementRenderRecoveryMigration,
  /submitted\.effect_type = 'pdd-submit'[\s\S]*submitted\.status IN \('succeeded', 'unknown'\)/);
assert.match(omsOrderManagementRenderRecoveryMigration,
  /current_step = 'oms-order-management-render-retry-ready'/);
assert.match(omsOrderManagementRenderRecoveryMigration,
  /INSERT INTO schema_migrations/);
assert.match(unrelatedReturnRefundTerminalTextRecoveryMigration,
  /refund\.action_button_visible = true[\s\S]*refund\.aftersale_status[\s\S]*待商家/u,
  'terminal-text recovery must require a visible action and a pending current status');
assert.match(unrelatedReturnRefundTerminalTextRecoveryMigration,
  /nonTerminalPage,actual,pageIndicatesCompleted}' = 'true'/);
assert.match(unrelatedReturnRefundTerminalTextRecoveryMigration,
  /nonTerminalPage,actual,scopedTerminalStatusPresent}'[\s\S]*'false'/);
assert.match(unrelatedReturnRefundTerminalTextRecoveryMigration,
  /effect\.effect_type = 'pdd-return-refund'[\s\S]*effect\.status = 'succeeded'/,
  'terminal-text recovery must exclude an already confirmed refund');
assert.match(unrelatedReturnRefundTerminalTextRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/,
  'terminal-text recovery must not race an active worker lease');
assert.doesNotMatch(unrelatedReturnRefundTerminalTextRecoveryMigration,
  /(?:UPDATE|DELETE FROM)\s+external_effects/i,
  'terminal-text recovery must preserve unknown and failed external effects');
assert.match(unrelatedReturnRefundTerminalTextRecoveryMigration,
  /UPDATE notification_outbox/);
assert.match(unrelatedReturnRefundTerminalTextRecoveryMigration,
  /terminalStatusScope', 'current-aftersale-field'/);
assert.match(unrelatedReturnRefundTerminalTextRecoveryMigration,
  /148_recover_unrelated_return_refund_terminal_text\.sql/);
assert.match(refundSubmissionReconciliationRecoveryMigration,
  /refund\.action_state = 'verification-required'/);
assert.match(refundSubmissionReconciliationRecoveryMigration,
  /confirmationDispatchStarted[\s\S]*confirmationClicked/);
assert.match(refundSubmissionReconciliationRecoveryMigration,
  /SET status = 'failed'[\s\S]*candidate\.confirmation_dispatched = false/,
  'an undispatched confirmation must release only its own unknown effect');
assert.match(refundSubmissionReconciliationRecoveryMigration,
  /succeeded\.effect_type = 'pdd-return-refund'[\s\S]*succeeded\.status = 'succeeded'/);
assert.match(refundSubmissionReconciliationRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(refundSubmissionReconciliationRecoveryMigration,
  /current_step = 'return-refund-page-error'/);
assert.match(refundSubmissionReconciliationRecoveryMigration,
  /UPDATE notification_outbox/);
assert.match(refundSubmissionReconciliationRecoveryMigration,
  /confirmationEnableWaitMs', 30000/);
assert.match(refundSubmissionReconciliationRecoveryMigration,
  /149_recover_refund_submission_reconciliation\.sql/);
assert.match(staleSavedDetailAbsenceRecoveryMigration,
  /stale-detail-pending-absence-loop-recovered/);
assert.match(staleSavedDetailAbsenceRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('reserved', 'succeeded', 'unknown'\)/);
assert.match(staleSavedDetailAbsenceRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(staleSavedDetailAbsenceRecoveryMigration,
  /150_recover_stale_saved_detail_absence_loops\.sql/);
assert.match(uncertainReturnRefundEffectRecoveryMigration,
  /effect\.status IN \('unknown', 'reserved'\)/);
assert.match(uncertainReturnRefundEffectRecoveryMigration,
  /effect\.reserved_at <= now\(\) - interval '30 minutes'/);
assert.match(uncertainReturnRefundEffectRecoveryMigration,
  /refund\.evidence#>>'\{fieldSources,orderNumber,value\}' = refund\.external_order_number/);
assert.match(uncertainReturnRefundEffectRecoveryMigration,
  /refund\.evidence#>>'\{fieldSources,aftersaleNumber,value\}' = refund\.aftersale_number/);
assert.match(uncertainReturnRefundEffectRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/,
  'uncertain refund recovery must not race an active lease');
assert.doesNotMatch(uncertainReturnRefundEffectRecoveryMigration,
  /UPDATE external_effects/,
  'the migration must preserve the uncertain effect for runtime read-only proof');
assert.match(uncertainReturnRefundEffectRecoveryMigration,
  /151_recover_actionable_uncertain_return_refund_effects\.sql/);
assert.match(workflow, /orderCell\.click\(\{ button: 'right', force: true \}\)/);
assert.doesNotMatch(workflow, /openOmsResendActionMenu/);
assert.match(workflow, /const runOmsManualAllocation[\s\S]*?await ensureOmsOrderManagementPage\(targetPage, browserContext\);\s*let \{ orderCell, rowScope, omsApiOrderState \} = await queryOmsOrderRow/);
assert.match(workflow, /const reconcileOmsManualAllocationState[\s\S]*?await ensureOmsOrderManagementPage\(targetPage, context\);\s*const \{ rowScope, omsApiOrderState \} = await queryOmsOrderRow/);
assert.match(workflow, /const reconcileOmsManualAllocationState[\s\S]*?omsApiOrderStateHasPassedAllocation\(omsApiOrderState\)/);
assert.match(workflow, /const scenarioSystemDependencies = \(scenarioCode\) => \{[\s\S]*ORDINARY_SCENARIO_DEPENDENCIES\[scenarioCode\]/);
assert.match(workflow, /const scenarioRequiresOms = \(scenarioCode\) => scenarioSystemDependencies\(scenarioCode\)\.oms === true/);
assert.match(workflow, /const scenarioRequiresTms = \(scenarioCode\) => scenarioSystemDependencies\(scenarioCode\)\.tms === true/);
assert.match(workflow, /const pddOrderRemarkText = '自动化'/);
assert.match(runner, /effect_type IN \('tms-create','pdd-submit','pdd-note','pdd-return-refund','evidence-upload','oms-manual-allocation','oms-reissue-create'\)/);
assert.match(runner, /const readSchemaState = async \(\) => \{[\s\S]*pg_get_constraintdef[\s\S]*effect_type_constraint_current/,
  'runner startup must inspect retry schema before attempting DDL');
assert.match(runner, /if \(state\.has_next_attempt_at[\s\S]*state\.effect_type_constraint_current\) return;/,
  'a current retry schema must avoid all startup DDL');
assert.match(runner, /if \(!state\.effect_type_constraint_current\) \{[\s\S]*DROP CONSTRAINT IF EXISTS external_effects_effect_type_check[\s\S]*ADD CONSTRAINT external_effects_effect_type_check/,
  'the external-effect constraint may be rebuilt only when schema inspection finds it outdated');
assert.match(runner, /const strandedEffects = \[\.\.\.activeExternalEffects\.entries\(\)\][\s\S]*effect\.childRunToken === childRunToken[\s\S]*ordinaryInstanceId: effect\.ordinaryInstanceId/);
assert.match(runner, /for \(const \[effectId, effect\] of activeEffectsForClaim\(claim, run\.child\)\)[\s\S]*ordinaryInstanceId: effect\.ordinaryInstanceId/);
assert.match(runner, /ordinaryIdentityFromExternalEffectMessage[\s\S]*platformWorkOrderId: String\(message\.platformWorkOrderId/);
assert.match(runner, /ordinaryIdentitiesMatch\(claimIdentity, messageIdentity\)/);
assert.match(runner, /activeEffect\.platformWorkOrderId !== messageIdentity\.platformWorkOrderId/);
assert.match(runner, /const progressBelongsToClaim[\s\S]*actual\.ordinaryInstanceId !== expected\.ordinaryInstanceId/);
assert.match(
  runner,
  /const completedProgressBelongsToClaim[\s\S]{0,1200}!expected\.ordinaryInstanceId[\s\S]{0,240}actual\.ordinaryInstanceId !== expected\.ordinaryInstanceId[\s\S]{0,400}expected\.platformWorkOrderId[\s\S]{0,260}expected\.platformCaseKey[\s\S]{0,260}ordinaryIdentityValidationError\(actual\)/,
  'legacy recovery completion may omit unavailable PDD platform ids but must retain the exact ordinary instance UUID',
);
assert.match(runner, /!progressMatchesInstance && !completedProgressMatchesInstance/);
assert.match(runner, /!progressBelongsToClaim\(progress, claim\) && !completedForClaim\(progress, claim\)/);
assert.match(runner, /const sameClaim = progressBelongsToClaim\(current, claim\) \|\| localLogisticsWait;[\s\S]*const currentIsNewer = !authoritativeRecoveryPayload && sameClaim/);
assert.match(runner, /const retryAfterMs = Date\.parse\(wait\.retryAfterAt \|\| ''\);\s*if \(Number\.isFinite\(retryAfterMs\) && retryAfterMs <= Date\.now\(\)\) return null;/,
  'an expired local logistics wait must continue the workflow instead of being requeued immediately');
assert.match(runner, /validateIdleCommandOrdinaryIdentity\(command\)[\s\S]*ordinaryInstanceId: command\.ordinary_instance_id \|\| null/);
const activeCommandGuard = runner.slice(
  runner.indexOf('async function applyActiveCommand'),
  runner.indexOf('async function processOne'),
);
assert(activeCommandGuard.indexOf("String(command.work_order_id || '')")
  < activeCommandGuard.indexOf("command.command_type === 'verification-recheck'"),
'active verification commands must validate work-order identity before acknowledging recheck');
assert.match(runner, /claimOrdinaryInstanceId: ordinaryIdentity\.ordinaryInstanceId[\s\S]*claimPlatformWorkOrderId: ordinaryIdentity\.platformWorkOrderId[\s\S]*claimPlatformCaseKey: ordinaryIdentity\.platformCaseKey/);
assert.match(postgresAdapter, /instance\.first_discovered_at AS ordinary_first_discovered_at/);
assert.match(runner, /PDD_WORK_ORDER_FIRST_DISCOVERED_AT: claimWorkOrderFirstDiscoveredAt/);
assert.match(runner, /workOrderFirstDiscoveredAt: claimWorkOrderFirstDiscoveredAt/);
assert.match(runner, /claimWorkOrderFirstDiscoveredAt: ordinaryFirstDiscoveredAtForClaim\(claim\)/);
assert.match(workflow, /activeWorkOrderFirstDiscoveredAt[\s\S]*progress\.workOrderFirstDiscoveredAt[\s\S]*progress\.latestDiscovery\?\.discoveredAt/);
assert.match(runner, /canonicalScenarioCode\(claim\.scenario_code\) === 'return-refund'[\s\S]*runReturnRefundClaim\(claim\)[\s\S]*startOrReusePlaywright/);
assert.match(workflow, /const pddOnlyRecovery = Boolean\(activeReturnRefundCommand\)[\s\S]*initializeResidentSystemsForDiscovery\(\)/);
assert.match(runner, /RETURN_REFUND_SCAN_ONCE/);
assert.match(runner, /returnRefundScanOnce \? 'false' : process\.env\.RETURN_REFUND_AUTO_APPROVE_ENABLED/);
assert.match(runner, /getReturnRefundRuntimeSettings/);
assert.match(runner, /refreshReturnRefundRuntimeSettings/);
assert.match(runner, /return-refund-\$\{mode\}-running/);
assert.equal(classifyReturnRefundWaitState({
  step: 'human-verification-required',
}).pausesActiveTimeout, true, 'verification must not consume the return-refund active timeout');
assert.equal(classifyReturnRefundWaitState({
  step: 'rate-limited-waiting',
}).pausesActiveTimeout, true, 'PDD rate-limit backoff must not consume the return-refund active timeout');
assert.equal(classifyReturnRefundWaitState({
  step: 'return-refund-detail-workbench-recovery-started',
}).pausesActiveTimeout, false, 'active workbench recovery must consume the bounded active timeout');
const activeRefundProgress = {
  step: 'return-refund-refresh-after-approve',
  businessUpdatedAt: '2026-08-19T12:00:00.000Z',
  updatedAt: '2026-08-19T12:00:00.000Z',
  residentCommand: { requestId: 'refund-request', status: 'active' },
};
const activeRefundMarker = returnRefundProgressMarker(activeRefundProgress, 'refund-request');
assert(activeRefundMarker, 'matching active return-refund progress must produce a marker');
assert.equal(returnRefundProgressMarker(activeRefundProgress, 'another-request'), null,
  'progress from another resident command must not extend the current request');
const refreshedRefundBudget = advanceReturnRefundWaitBudget({
  remainingMs: 1_000,
  elapsedMs: 500,
  timeoutMs: 5_000,
  previousProgressMarker: null,
  progress: activeRefundProgress,
  requestId: 'refund-request',
});
assert.equal(refreshedRefundBudget.remainingMs, 4_500,
  'fresh matching progress must refresh the soft timeout before charging elapsed work');
const stalledRefundBudget = advanceReturnRefundWaitBudget({
  remainingMs: refreshedRefundBudget.remainingMs,
  elapsedMs: 500,
  timeoutMs: 5_000,
  previousProgressMarker: refreshedRefundBudget.progressMarker,
  progress: activeRefundProgress,
  requestId: 'refund-request',
});
assert.equal(stalledRefundBudget.remainingMs, 4_000,
  'unchanged active progress must continue consuming the soft timeout');
const runtimeOnlyRefundHeartbeat = advanceReturnRefundWaitBudget({
  remainingMs: stalledRefundBudget.remainingMs,
  elapsedMs: 500,
  timeoutMs: 5_000,
  previousProgressMarker: stalledRefundBudget.progressMarker,
  progress: {
    ...activeRefundProgress,
    updatedAt: '2026-08-19T12:00:30.000Z',
    runtimeObservation: { observedAt: '2026-08-19T12:00:30.000Z' },
  },
  requestId: 'refund-request',
});
assert.equal(runtimeOnlyRefundHeartbeat.progressAdvanced, false,
  'a runtime-only browser heartbeat must not renew the refund inactivity budget');
assert.equal(runtimeOnlyRefundHeartbeat.remainingMs, 3_500);
const sameStepBusinessAdvance = advanceReturnRefundWaitBudget({
  remainingMs: runtimeOnlyRefundHeartbeat.remainingMs,
  elapsedMs: 500,
  timeoutMs: 5_000,
  previousProgressMarker: runtimeOnlyRefundHeartbeat.progressMarker,
  progress: {
    ...activeRefundProgress,
    businessUpdatedAt: '2026-08-19T12:00:31.000Z',
    updatedAt: '2026-08-19T12:00:31.000Z',
  },
  requestId: 'refund-request',
});
assert.equal(sameStepBusinessAdvance.progressAdvanced, true,
  'a real same-stage business update must still renew the inactivity budget');
assert.equal(sameStepBusinessAdvance.remainingMs, 4_500);
const advancedRefundBudget = advanceReturnRefundWaitBudget({
  remainingMs: sameStepBusinessAdvance.remainingMs,
  elapsedMs: 500,
  timeoutMs: 5_000,
  previousProgressMarker: sameStepBusinessAdvance.progressMarker,
  progress: {
    ...activeRefundProgress,
    step: 'return-refund-detail-rendered',
    businessUpdatedAt: '2026-08-19T12:00:32.000Z',
    updatedAt: '2026-08-19T12:00:32.000Z',
  },
  requestId: 'refund-request',
});
assert.equal(advancedRefundBudget.remainingMs, 4_500,
  'a later adapter step must renew the inactivity budget');
const verificationRefundBudget = advanceReturnRefundWaitBudget({
  remainingMs: 2_000,
  elapsedMs: 500,
  timeoutMs: 5_000,
  previousProgressMarker: advancedRefundBudget.progressMarker,
  progress: {
    ...activeRefundProgress,
    step: 'human-verification-required',
    updatedAt: '2026-08-19T12:00:02.000Z',
  },
  requestId: 'refund-request',
});
assert.equal(verificationRefundBudget.remainingMs, 5_000,
  'verification progress must pause the soft timeout');
const verificationHardTimeout = createReturnRefundWaitTimeoutError({
  progress: {
    step: 'human-verification-required',
    authHealth: { pdd: { status: 'verification-required' } },
  },
  mode: 'claim',
  timeoutMs: 20 * 60_000,
  hardLimit: true,
});
assert.equal(verificationHardTimeout.code, 'PDD_HUMAN_VERIFICATION_REQUIRED',
  'a hard deadline reached during verification must remain a recoverable verification state');
assert.equal(verificationHardTimeout.kind, 'verification-required');
const stalledHardTimeout = createReturnRefundWaitTimeoutError({
  progress: { step: 'return-refund-detail-rendered' },
  mode: 'claim',
  timeoutMs: 20 * 60_000,
  hardLimit: true,
});
assert.equal(stalledHardTimeout.code, 'RETURN_REFUND_HARD_TIMEOUT',
  'a genuine active-work stall must retain the bounded hard timeout');
assert.equal(stalledHardTimeout.kind, 'page-error');
const protectedStall = classifyReturnRefundUnexpectedFailure(stalledHardTimeout, {
  externalEffectStarted: true,
});
assert.equal(protectedStall.outcome, 'page-error');
assert.match(protectedStall.reasons[0], /只读复核|不会重复点击/,
  'a hard timeout after an external effect must remain protected from duplicate submission');
assert.match(runner, /advanceReturnRefundWaitBudget/);
assert.match(runner, /createReturnRefundWaitTimeoutError/);
assert.match(runner, /WORKER_RETURN_REFUND_RESULT_TIMEOUT_MS/);
assert.match(runner, /WORKER_RETURN_REFUND_HARD_TIMEOUT_MS/);
assert.match(runner, /const hardDeadline = checkedAt \+ hardTimeoutMs/);
assert.match(runner, /remainingMs = waitState\.remainingMs/);
assert.match(runner, /rate-limited-waiting/);
assert.match(runner, /returnRefundCycleCursor/);
assert.match(runner, /RETURN_REFUND_COMBINED_BATCH_ITEMS/);
assert.match(runner,
  /returnRefundCombinedBatchItems[\s\S]{0,180}RETURN_REFUND_COMBINED_BATCH_ITEMS \|\| 3/,
  'mixed resident workers must keep refund scan batches short enough for ordinary preemption');
assert.match(runner,
  /returnRefundCombinedBatchMaxDurationMs[\s\S]{0,220}RETURN_REFUND_COMBINED_BATCH_MAX_DURATION_MS \|\| 90_000/,
  'mixed resident workers must bound refund scan wall time before ordinary preemption');
assert.match(runner,
  /returnRefundCombinedScanVerificationBudgetMs[\s\S]{0,280}RETURN_REFUND_COMBINED_SCAN_VERIFICATION_BUDGET_MS \|\| 30_000/,
  'background refund scans must use a short verification budget before ordinary preemption');
assert.match(runner,
  /maxDurationMs: mixedBusinessSlotSession[\s\S]{0,180}Math\.min\(returnRefundScanMaxDurationMs, returnRefundCombinedBatchMaxDurationMs\)[\s\S]{0,120}: returnRefundScanMaxDurationMs/,
  'only mixed business sessions may shorten a refund scan while dedicated refund scans keep their full duration');
assert.match(runner,
  /mixedBusinessSlotSession \? \{[\s\S]{0,120}verificationBudgetMs: returnRefundCombinedScanVerificationBudgetMs[\s\S]{0,80}: \{\}/,
  'only a mixed background scan may shorten the verification window');
assert.match(workflow,
  /verificationBudgetMs: command\.verificationBudgetMs == null[\s\S]{0,240}returnRefundVerificationBudgetMs/,
  'resident commands must preserve the full refund verification budget unless a bounded scan override is supplied');
assert.match(workflow,
  /returnRefundCommand\.verificationBudgetMs > 0[\s\S]{0,180}limitMs: returnRefundCommand\.verificationBudgetMs/,
  'verification waiting must consume the command-specific scan budget');
assert.match(runner,
  /returnRefundScanRetryNotBefore = 0;[\s\S]*returnRefundCycleCursor = fullScanCompleted/,
  'only a successfully persisted scan batch may clear the retry delay');
assert.doesNotMatch(runner,
  /returnRefundCycleVisitedCursors\.add\(cursorKey\);\s*lastReturnRefundScanAt = Date\.now\(\);/,
  'a verification-interrupted scan must not consume the successful scan interval');
assert.match(runner,
  /if \(!fullScanCompleted[\s\S]{0,600}Return-refund scan cursor did not advance[\s\S]{0,240}returnRefundCycleVisitedCursors\.add\(cursorKey\);/,
  'a failed refund scan must remain able to retry the same durable cursor');
assert.ok(
  runner.indexOf('returnRefundCycleVisitedCursors.add(cursorKey);')
    > runner.indexOf('const persistedCursor = await repository.setReturnRefundScanCursor'),
  'a refund cursor must be marked visited only after the successful batch is persisted',
);
assert.match(runner,
  /verificationRetryScheduled: retry\.verificationRequired/,
  'verification-interrupted scans must publish their automatic retry schedule');
assert.match(runner, /let ordinaryOpportunitySinceRefundTurn = false/,
  'a fresh resident runner must check eligible ordinary work before taking its first refund turn');
assert.match(runner,
  /lastProcessedScenarioCode = canonicalScenarioCode\(claim\.scenario_code\);[\s\S]{0,700}lastProcessedScenarioCode === 'return-refund'[\s\S]{0,220}ordinaryOpportunitySinceRefundTurn = false/,
  'every refund claim path must reset fairness and yield the next eligible turn to ordinary work');
assert.match(runner,
  /const claimEligibleOrdinary = \(\) => repository\.claimNext\([\s\S]{0,500}scenarioCodes: ordinaryScenarioCodes/,
  'ordinary queue claims must use one identity-aware helper');
const successfulOrdinaryDiscoveryStart = runner.indexOf(
  "if (discovery?.status === 'discovered' && discovery.orderNumber)",
);
const successfulOrdinaryDiscoverySource = runner.slice(
  successfulOrdinaryDiscoveryStart,
  runner.indexOf(
    "if (['verification-required', 'login-required', 'rate-limited', 'retryable-error'",
    successfulOrdinaryDiscoveryStart,
  ),
);
assert.ok(successfulOrdinaryDiscoverySource.length > 0,
  'the successful ordinary discovery branch must be present');
assert.ok(
  successfulOrdinaryDiscoverySource.indexOf('queued = await repository.enqueueDiscovered')
    < successfulOrdinaryDiscoverySource.indexOf('lastDiscoveryAt = 0;'),
  'only a successfully persisted ordinary discovery may release the next scan cooldown',
);
assert.match(
  successfulOrdinaryDiscoverySource,
  /lastDiscoveryAt = 0;[\s\S]*ordinaryOpportunitySinceRefundTurn = false;/u,
  'a visible ordinary backlog must continue immediately after the current order while preserving refund fairness',
);
assert.match(runner,
  /A browser scan can run long enough[\s\S]{0,220}claim = await claimEligibleOrdinary\(\)/,
  'ordinary work becoming due during discovery must be rechecked before refund fallback');
assert.match(runner,
  /The refund scan itself can also cross an ordinary retry deadline[\s\S]{0,220}claim = await claimEligibleOrdinary\(\)/,
  'ordinary work becoming due during a refund scan must be rechecked before a refund claim');
assert.match(postgresAdapter, /async getReturnRefundRuntimeSettings/);
assert.match(runner,
  /async function processOne\(\) \{\s*await refreshReturnRefundRuntimeSettings\(\);[\s\S]{0,500}const progressBeforeAuthentication = await readProgress[\s\S]{0,360}workflowAuthenticationState\(progressBeforeAuthentication, \{[\s\S]{0,100}requiredSystems: \['pdd'\][\s\S]{0,80}\}\)[\s\S]{0,120}if \(authentication\.blocked\)[\s\S]{0,2200}if \(!await ensureDynamicPddShopBindingReady\(\)\) return false;\s*const terminalReturnRefundVerificationRecovery =[\s\S]*resolveTerminalReturnRefundVerifications\(\{ shopId \}\);[\s\S]*const preClaimVerificationRecovery = await recoverDetachedClearedReturnRefundVerification\(\);[\s\S]*preClaimVerificationGate[\s\S]*return false;[\s\S]*await hydrateReturnRefundScanCursor\(\);[\s\S]*releaseOwnedLeaseForIdentityBinding[\s\S]*if \(returnRefundScanOnce\)[\s\S]*await runReturnRefundScan\(\);[\s\S]*returnRefundScanOnceCompleted = true;[\s\S]*await reconcileCompletedDatabaseOrder\(\)/,
  'each worker turn must consume an exact detached verification clear and block new claims while any challenge remains');
assert.match(runner,
  /repository\.getReturnRefundScanCursor\(shopId\)[\s\S]*cycleCompleted[\s\S]*lastReturnRefundScanAt[\s\S]*returnRefundCycleTotals/,
  'resident workers must resume a durable partial scan and preserve a completed scan interval');
assert.match(runner,
  /const persistedAt = Date\.parse\(String\(persistedCursor\.updatedAt \|\| ''\)\);[\s\S]{0,180}lastReturnRefundScanAt = Number\.isFinite\(persistedAt\) \? persistedAt : 0;[\s\S]{0,260}if \(!cycleCompleted\)/,
  'a durable partial scan must retain its last batch timestamp so ready refunds can run before the next batch');
assert.match(runner,
  /Allow the next worker turn to continue the same round after one normal[\s\S]{0,140}lastReturnRefundScanAt = Date\.now\(\);/,
  'a partial scan batch must yield to ready refunds before continuing its cursor');
assert.match(postgresAdapter,
  /async getReturnRefundScanCursor[\s\S]*updatedAt[\s\S]*Number\.isFinite\(Date\.parse\(updatedAt\)\)/,
  'the durable cursor must expose its persisted timestamp for restart scheduling');
assert.match(runner, /identityBindingToken: dynamicPddShopBinding \? currentPddIdentityBindingToken : null/);
assert.match(runner, /CREATE TABLE pdd_shop_runtime_bindings/);
assert.match(runner, /pdd-identity-duplicate/);
assert.match(postgresAdapter, /identity_refund\.evidence->>'pddIdentityBindingToken' = \$3/);
assert.match(postgresAdapter, /work_order\.payload->'latestDiscovery'->>'pddIdentityBindingToken' = \$3/);
assert.match(postgresAdapter, /async releaseOwnedLeaseForIdentityBinding/);
assert.match(postgresAdapter, /async \(existingWorkOrder\) => \{[\s\S]*existingWorkOrder\.shop_id === shopId[\s\S]*UPDATE work_orders SET shop_id = \$2/);
assert.match(postgresAdapter, /WHERE refund\.aftersale_number = \$1[\s\S]*UPDATE return_refunds SET shop_id = \$2/);
assert.match(runner, /async function listDiscoveryExcludedPlatformCaseKeys\(\)[\s\S]*ordinary_work_order_instances[\s\S]*platform_case_key/);
assert.match(runner, /rediscoveryResult[\s\S]*binding\.binding_token = \$2::uuid[\s\S]*work_order\.status = 'paused'[\s\S]*work_order\.completion_state = 'pending'[\s\S]*effect\.effect_type = 'pdd-submit' AND effect\.status = 'succeeded'[\s\S]*effect\.effect_type = 'evidence-upload' AND effect\.status = 'failed'/,
  'only safe paused cross-shop rows may be exposed for authoritative browser rediscovery');
assert.match(runner, /rediscoverableKeys[\s\S]*!rediscoverableKeys\.has\(platformCaseKey\)/,
  'safe browser-truth candidates must be removed from the global platform-case exclusion set');
assert.match(postgresAdapter, /PDD_CROSS_SHOP_IDENTITY_UNVERIFIED[\s\S]*PDD_CROSS_SHOP_REDISCOVERY_UNSAFE/,
  'cross-shop rediscovery must require a current verified binding and retain an unsafe-state fence');
assert.match(postgresAdapter, /recoverBrowserTruthPaused[\s\S]*pdd-browser-truth-identity-retry-ready[\s\S]*exactBoundOperational[\s\S]*boundWorkOrderId/,
  'an exact platform case must select, relocate and resume only its matching paused record');
assert.match(postgresAdapter, /effect_type = 'pdd-submit' AND status = 'succeeded'[\s\S]*effect_type = 'evidence-upload' AND status IN \('failed','unknown'\)/,
  'successful PDD submits and failed or unknown evidence uploads must never be replayed during relocation');
assert.match(runner, /async function listDiscoveryExcludedOrdinaryCandidates\(\)[\s\S]*external_order_number AS "orderNumber"[\s\S]*first_discovered_at AS "firstDiscoveredAt"/,
  'discovery must load known ordinary instances with enough identity to skip only the same PDD list row');
assert.match(runner, /const excludedPlatformCaseKeys = await listDiscoveryExcludedPlatformCaseKeys\(\);[\s\S]*const excludedOrdinaryCandidates = await listDiscoveryExcludedOrdinaryCandidates\(\);[\s\S]*discovery = await discoverPendingOrder\(\s*excludedPlatformCaseKeys,\s*excludedOrdinaryCandidates,\s*\)/);
assert.match(runner, /PDD_EXCLUDED_ORDINARY_CANDIDATES: JSON\.stringify\(excludedOrdinaryCandidates\)/,
  'legacy discovery startup must receive known ordinary list candidates');
assert.match(runner, /sendWorkflowCommand\(\{\s*action: 'discover',\s*excludedPlatformCaseKeys,\s*excludedOrdinaryCandidates,\s*\}\)/,
  'resident discovery commands must receive known ordinary list candidates');
assert.match(workflow, /findKnownOrdinaryDiscoveryExclusion\([\s\S]*discoveryExcludedOrdinaryCandidates[\s\S]*reason: 'excluded-known-list-candidate'/,
  'workflow discovery must skip a verified known ordinary instance before opening its detail');
assert.doesNotMatch(runner, /listDiscoveryExcludedOrderNumbers\(/);
assert.match(runner,
  /WORKFLOW_SHOP_ID: shopId,[\s\S]{0,120}WORKFLOW_SHOP_DISPLAY_SLOT: String\(shop\.displaySlot \?\? 0\)/,
  'the worker must pass each shop display slot to stagger resident OMS startup');
assert.match(runner, /if \(!activeChildRunning\(\)\) \{\s*run = startLegacyPlaywright\(null, \{\s*discoverOnly: true,\s*excludedPlatformCaseKeys,\s*excludedOrdinaryCandidates,\s*\}\);\s*\}\s*await waitForActiveResidentReady\(\);\s*const accepted = await sendWorkflowCommand\(\{\s*action: 'discover'/,
  'a newly started resident browser must become ready before the initial discovery command is sent');
assert.match(runner, /discovery reuse failed:[\s\S]*return recoverDiscoveryFailure\([\s\S]*PDD resident discovery command failed:/,
  'a failed resident discovery command must recycle only the browser child and remain inside the shop runner');
assert.match(runner, /const settledReadyPromise = readyPromise\.then\([\s\S]*\(error\) => \(\{ ready: true, value: null, error \}\)[\s\S]*if \(result\.error\) throw result\.error/,
  'resident startup readiness must consume rejected promises without crashing the shop runner');
assert.match(runner, /const minimumDurationMs = \(value, fallback, minimum\)[\s\S]*Number\.isFinite\(parsed\)[\s\S]*WORKER_RESIDENT_READY_TIMEOUT_MS[\s\S]*PDD_DISCOVERY_RESULT_TIMEOUT_MS/,
  'resident ready and discovery timeouts must fall back when environment values are invalid');
assert.match(runner, /const discoveryResultTimeoutMs = minimumDurationMs\([\s\S]*PDD_DISCOVERY_RESULT_TIMEOUT_MS/,
  'discovery must retain a bounded result timeout');
assert.match(runner, /const verificationWaiting = \['human-verification-required', 'manual-login-required'\][\s\S]*if \(!verificationWaiting\) remainingMs -= now - checkedAt[\s\S]*return recoverDiscoveryFailure/,
  'discovery must recycle the resident browser on timeout while preserving active verification waits');
assert.match(runner, /async function recoverDiscoveryFailure\(error\)[\s\S]*activeExternalEffects\.size > 0[\s\S]*await stopActiveChildGracefully\(10_000\)[\s\S]*status: 'retryable-error'[\s\S]*recovery: 'resident-browser-recycled'/,
  'discovery recovery must preserve active external effects and contain retryable failures inside the runner');
assert.match(runner, /async function restoreResidentBrowserDuringDiscoveryCooldown\(\)[\s\S]*startLegacyPlaywright\(null, \{ discoverOnly: true \}\)[\s\S]*resident-browser-recovered/,
  'discovery cooldown must restore the resident shop browser without immediately issuing another scan');
assert.match(runner, /await restoreResidentBrowserDuringDiscoveryCooldown\(\)[\s\S]*Date\.now\(\) >= discoveryRetryNotBefore[\s\S]*discovery = await recoverDiscoveryFailure\(error\)/,
  'unexpected discovery failures must use cooldown recovery instead of terminating the shop runner');
assert.match(runner, /const childStartedAt = Date\.now\(\)[\s\S]*residentReadyRemainingMs[\s\S]*progressUpdatedAt >= childStartedAt[\s\S]*manual-login-required[\s\S]*if \(!currentChildWaitsForHuman\) residentReadyRemainingMs -= elapsedMs/,
  'resident startup timeout must pause for a current child waiting on human login or verification');
assert.match(runner, /const waitForActiveResidentReady = async \(\) => \{[\s\S]*Promise\.race[\s\S]*observeOnboardingProgress\(\)/,
  'resident startup waits must continue publishing login and verification heartbeats');
assert.match(runner, /workflowAuthenticationState\(progress\)/,
  'the Worker must resolve login ownership through the tested multi-system policy');
assert.match(runner, /system: authenticationSystem,[\s\S]*observedStatus: manualLoginRequired/,
  'expired claim recovery must retain the actual blocked authentication system');
assert.match(runner, /\(manualLoginRequired && authenticationSystem === 'pdd'\)[\s\S]*onboardingStatus = 'waiting-login'/,
  'an OMS or TMS login wait must not downgrade the already verified PDD onboarding state');
assert.match(runner, /const onboardingWorkerState = humanVerificationRequired[\s\S]*'manual-login-required'[\s\S]*await heartbeat\(onboardingWorkerState,[\s\S]*authenticationSystem,[\s\S]*authenticationStatus:/,
  'onboarding heartbeats must expose human verification and manual login instead of queue discovery');
assert.match(runner, /assignmentKind === 'refund-scan'[\s\S]*persistentSlotSession && schedule\.rows\[0\]\.refund_scan_in_progress[\s\S]*returnRefundCycleCursor = schedule\.rows\[0\]\.refund_scan_cursor/,
  'resident sessions must resume an interrupted refund scan even when initially assigned ordinary work');
assert.match(runner, /\(!returnRefundScanOnceCompleted \|\| returnRefundKeepBrowserOpen\)/);
assert.match(runner, /canonicalDetectedPddShopName/);
assert.notEqual(
  canonicalDetectedPddShopName('PANAPOPO医疗保健旗舰店'),
  canonicalDetectedPddShopName('PANAPOPO医疗保健官方旗舰店'),
  '“旗舰店”和“官方旗舰店”必须保留为两个独立的拼多多店铺身份',
);
assert.equal(
  canonicalDetectedPddShopName('PANAPOPO医疗保健旗舰店林动'),
  canonicalDetectedPddShopName('PANAPOPO医疗保健旗舰店'),
  '店铺账号昵称后缀不应改变真实店铺身份',
);
assert.match(runner, /if \(!fingerprintMatches\)/);
assert.match(runner,
  /const returnRefundPddOnly = returnRefundScanOnce \|\| returnRefundOnly \|\| directRefundExecutionSession/);
assert.match(runner, /const omsMode = String\(process\.env\.OMS_MODE \|\| 'per-shop'\)/);
assert.match(runner, /readCredentialPair\(omsMode === 'shared'[\s\S]*\? \['JEOMS'\][\s\S]*`JEOMS_\$\{omsShopKey\}`/,
  'per-shop OMS mode must resolve isolated credentials instead of reusing the global account');
assert.match(runner,
  /claim = returnRefundOnly \|\| directRefundExecutionSession[\s\S]{0,500}\? await repository\.claimNext\([\s\S]{0,500}scenarioCodes: \['return-refund'\][\s\S]{0,500}: await claimEligibleOrdinary\(\)/);
assert.equal((postgresAdapter.match(/refund\.work_order_id = work_order\.id AND \(\s*refund\.action_state = 'ready'/g) || []).length, 2,
  'new claims and recovered leases must both retain ready return-refund eligibility');
assert.equal((postgresAdapter.match(/refund\.action_state = 'waiting-logistics'/g) || []).length, 2,
  'new claims and recovered leases must both recheck overdue waiting-logistics refunds');
assert.match(postgresAdapter, /refund\.action_state = 'page-error'\s+AND work_order\.status = 'retry-ready'/,
  'only explicitly retry-ready page errors may return to the refund execution queue');
assert.match(postgresAdapter,
  /scheduled_refund\.work_order_id = work_order\.id[\s\S]{0,200}scheduled_refund\.next_check_at <= now\(\)/,
  'an overdue authoritative refund schedule must override a stale work-order retry timestamp');
assert.match(runner, /RETURN_REFUND_DIRECT_CLAIMS_BEFORE_SCAN \|\| 4/);
assert.match(runner,
  /shouldPrioritizeReturnRefundScan\(\{[\s\S]{0,500}directClaimsSinceScan: returnRefundDirectClaimsSinceScan[\s\S]{0,240}directClaimsBeforeScan: returnRefundDirectClaimsBeforeScan[\s\S]{0,240}forceIntervalMs: returnRefundScanForceIntervalMs/,
  'direct refund rechecks must periodically yield to full-list scanning');
assert.match(runner, /allowOperatorPaused: returnRefundOnly/);
assert.match(runner, /\.\.\.\(returnRefundPddOnly \? \{\} : \{[\s\S]*JEOMS_ACCOUNT:[\s\S]*TMS_ACCOUNT:/);
assert.match(workflow, /const returnRefundScanOnceMode = process\.env\.RETURN_REFUND_SCAN_ONCE === 'true'/);
assert.match(workflow, /if \(returnRefundPddOnlyMode\) \{\s*await omsPage\.close\(\)[\s\S]*await tmsPage\.close\(\)/);
assert.match(workflow,
  /if \(process\.env\.PDD_DISCOVER_ONLY === 'true'\) \{[\s\S]*if \(residentCommandMode\) \{[\s\S]*type: 'workflow-resident-ready'[\s\S]*await initializeResidentSystemsForDiscovery\(\);[\s\S]*if \(!residentCommandMode\) \{[\s\S]*await runPddDiscoveryOnly\(\)/,
  'resident readiness must be signaled before slow system navigation begins');
assert.match(
  workflow,
  /blockedSystemPages = \(blockedContext\?\.pages\(\) \|\| \[\]\)\.filter[\s\S]*?workflowSystemForAction\(page\) === blockedSystem[\s\S]*?for \(const candidate of blockedSystemPages\)[\s\S]*?hasHumanVerification\(candidate\)/,
  'resident runtime observation must not clear a derived-tab verification from an authenticated anchor tab',
);
assert.match(
  workflow,
  /await runScenarioStagesAfterOms\(completedOrderNumber\);[\s\S]{0,500}runPddResolutionWorkflow\(detailPage, completedOrderNumber\)/,
  'ordinary resolution must reuse the rendered identity-checked detail tab after OMS/TMS',
);
assert.doesNotMatch(
  workflow,
  /await runScenarioStagesAfterOms\(completedOrderNumber\);[\s\S]{0,500}runPddResolutionWorkflow\(pddPage, completedOrderNumber\)/,
  'ordinary resolution must not reopen the case from the permanent PDD list anchor',
);
const residentDiscoveryBootstrap = workflow.slice(
  workflow.indexOf("if (process.env.PDD_DISCOVER_ONLY === 'true')"),
  workflow.indexOf('if (!reconcileExternalStateOnly && !residentSystemsInitialized)'),
);
assert.match(postgresAdapter, /const pageError = outcome === 'page-error'/);
assert.match(postgresAdapter, /RETURN_REFUND_PAGE_ERROR_RECHECK_MS/);
assert.match(workflow, /classifyReturnRefundUnexpectedFailure\(error,[\s\S]*externalEffectStarted: Boolean\(activeRefundEffectId\)/);
assert.match(runner, /classifyReturnRefundUnexpectedFailure\(error,[\s\S]*\['reserved', 'unknown'\]\.includes\(failedRefund\?\.effect_status\)/);
assert.match(residentDiscoveryBootstrap, /if \(residentCommandMode\)[\s\S]*resetResidentAssignment\(\)/);
assert.match(residentDiscoveryBootstrap, /workflow-resident-ready/,
  'resident workflow must explicitly signal that it can accept the first command');
assert.ok(
  residentDiscoveryBootstrap.indexOf("type: 'workflow-resident-ready'")
    < residentDiscoveryBootstrap.indexOf('await initializeResidentSystemsForDiscovery()'),
  'resident command readiness must not wait for PDD or TMS navigation',
);
assert.doesNotMatch(
  residentDiscoveryBootstrap.match(/if \(residentCommandMode\) \{([\s\S]*?)\}\s*await initializeResidentSystemsForDiscovery/)?.[1] || '',
  /runPddDiscoveryOnly/,
  'resident browser startup must wait for a runner command before discovery',
);
assert.match(omsManualAllocationMigration, /'oms-manual-allocation'/);
assert.match(workflow, /WORKFLOW_DISCOVERY_KEEP_ALIVE/);
assert.match(workflow, /WORKFLOW_RESIDENT_COMMAND_MODE/);
assert.match(workflow, /const seenRowFingerprints = new Set\(\)/);
assert.match(workflow, /const discoveryKey = buildDiscoverySelectionKey\(\{/);
assert.match(workflow, /pageNumber,\s*scenarioCode: scenario\.code,/);
assert.match(workflow, /rememberDiscoverySelection\(skippedSelectionKeys, selection\)/);
assert.match(workflow,
  /if \(!orderNumber \|\| !platformIdentity\.platformWorkOrderId \|\| !platformIdentity\.platformCaseKey\) \{[\s\S]*rememberDiscoverySelection\(skippedSelectionKeys, selection\)[\s\S]*platform-work-order-identity-unavailable[\s\S]*continue;/,
  'ordinary discovery must skip an invalid detail identity and continue scanning the same page set');
assert.match(runner,
  /repository\.enqueueDiscovered\([\s\S]*rejectedDiscoveryCodes\.has\(error\?\.code\)[\s\S]*pdd-discovery-identity-rejected[\s\S]*invalid-discovery-row-skipped/,
  'an invalid discovery identity must remain contained inside the shop runner');
assert.match(workflow, /workflow-command-accepted/);
assert.match(runner,
  /const residentCommandApplyTimeoutMs = minimumDurationMs\([\s\S]*WORKER_RESIDENT_COMMAND_APPLY_TIMEOUT_MS[\s\S]*60_000[\s\S]*30_000/,
  'resident commands must have a bounded apply timeout after IPC receipt');
assert.match(runner,
  /message\.type === 'workflow-command-received'[\s\S]{0,700}pending\.timer = setTimeout\([\s\S]{0,500}workflowCommandRequests\.delete\(message\.requestId\)[\s\S]{0,300}常驻浏览器任务应用超时/,
  'receiving a resident command must arm a second timeout until the workflow accepts it');
assert.match(runner,
  /error\.code = 'RESIDENT_COMMAND_APPLY_TIMEOUT'[\s\S]{0,120}error\.requestId = message\.requestId/,
  'a delayed resident command must preserve its request identity for scoped recovery');
assert.match(runner,
  /ensurePreClaimVerificationBrowser[\s\S]*RESIDENT_COMMAND_RECEIVE_TIMEOUT[\s\S]*RESIDENT_COMMAND_APPLY_TIMEOUT[\s\S]*request-received-delayed[\s\S]*request-retry-deferred/,
  'verification recovery queue delays must keep the shop Worker alive instead of dropping its browser');
assert.match(runner,
  /const applyTimeoutMs = Math\.max\(timeoutMs, residentCommandApplyTimeoutMs\)[\s\S]{0,500}applyTimeoutMs,/,
  'ordinary commands must use the apply timeout while longer refund command timeouts remain intact');
assert.match(runner,
  /const requestStop = \(signal\) => \{[\s\S]{0,500}has_unresolved_external_effects[\s\S]{0,300}activeEffectsForClaim\(\)\.length[\s\S]{0,300}activeChild\.send\(\{ type: 'shutdown' \}/,
  'a safe supervisor stop must interrupt a half-delivered resident command without abandoning an active external effect');
assert.match(runner,
  /process\.on\('message', \(message\) => \{\s*if \(message\?\.type === 'shutdown'\) requestStop\('supervisor-ipc'\)/,
  'the Windows supervisor must stop a shop runner through IPC instead of a forceful pseudo-signal');
assert.match(runner,
  /order reuse failed:[\s\S]{0,220}stopActiveChildGracefully\(\);[\s\S]{0,220}if \(stopped\)[\s\S]{0,260}stopping: true/,
  'a stopping runner must not launch a replacement browser after interrupting a pending resident command');
assert.match(workflow, /resetResidentAssignment/);
assert.match(workflow, /const completeFailedResidentCommand = async/);
assert.match(workflow, /if \(action === 'discover'\) \{[\s\S]*await completeFailedResidentCommand\(action, error\)/);
assert.match(workflow, /if \(action === 'refund-scan'\) \{[\s\S]*await completeFailedResidentCommand\(action, error\)/);
assert.match(workflow, /writePddDiscoveryOutput\(result\)/);
assert.match(workflow, /step: 'resident-discovery-reset'/);
assert.match(workflow, /const browserContextUnavailableFailure = \(error\) =>/);
assert.match(workflow, /const usableContextPageCount = \(\) => \{/);
assert.match(workflow, /const createBackgroundPage = async \(\) => \{[\s\S]*!browser\.isConnected\(\)[\s\S]*browser\.newBrowserCDPSession\(\)[\s\S]*context\.waitForEvent\('page'/,
  'background tabs must only be created after the browser connection and CDP session are available');
assert.match(workflow,
  /context\.pages\(\)\.find\(\(page\) => !existingPages\.has\(page\) && !page\.isClosed\(\)\)[\s\S]*recovered a background tab/,
  'a successfully created background tab must be recovered when Playwright misses its page event');
assert.match(workflow,
  /Target\.closeTarget[\s\S]*background target did not attach[\s\S]*context\.newPage\(\)/,
  'a background target that never attaches must be closed and replaced without crashing the shop workflow');
assert.match(workflow, /const browserCdp = await browser\.newBrowserCDPSession\(\);[\s\S]{0,160}try \{[\s\S]*context\.waitForEvent\('page'[\s\S]*finally \{\s*await browserCdp\.detach\(\)\.catch/,
  'the background-tab CDP session must always be detached when the context closes mid-creation');
assert.match(workflow,
  /const closeBrowserBeforeExit = \(exitCode, reason, error = null\) => \{[\s\S]*context\.close\(\)[\s\S]*markChromiumProfileClean\(\)[\s\S]*releaseWorkflowLock\(\)[\s\S]*process\.exit\(exitCode\)/,
  'fatal workflow exits must close Chromium and release its persistent profile before the runner restarts');
assert.match(workflow, /process\.once\('uncaughtException'[\s\S]*process\.once\('unhandledRejection'/,
  'startup failures must use the same graceful browser shutdown path');
assert.match(workflow, /if \(pddPage\.isClosed\(\)\) \{\s*pddPage = monitorSystemPage\('pdd', await createBackgroundPage\(\)\);/);
assert.match(workflow, /const resetPddAfterResidentDiscoveryFailure = async \(failure\) => \{[\s\S]*!browser\.isConnected\(\)[\s\S]*exitForBrowserFailure\('resident-discovery-reset-context-unavailable', failure\)[\s\S]*browserContextUnavailableFailure\(error\)[\s\S]*exitForBrowserFailure\('resident-discovery-reset-context-unavailable', error\)/,
  'a closed resident browser context must be handed back to the shop runner instead of escaping as an unhandled rejection');
assert.match(workflow, /if \(action === 'discover' && !\['rate-limited', 'login-required'\]\.includes\(status\)\) \{\s*await resetPddAfterResidentDiscoveryFailure\(error\);/,
  'a real discovery failure may reset the list page, but a visible login page must remain available');
assert.match(workflow, /if \(isExtendedOrdinaryScenario\(extendedScenarioCode\)\)[\s\S]*await ensurePddResolutionDetailReady\([\s\S]*settleMs: Math\.max\(pddDetailSettleMs, 30_000\)/);
assert.deepEqual(
  expandOrdinaryPddOptionAliases(['未收到退货商品']),
  ['未收到退货商品', '未收到退回的商品', '未收到退回商品', '未收到退货', '未查到退货商品'],
  'known PDD wording variants must use controlled semantic option groups',
);
assert.match(omsReissueAdapter, /\^\(\?:补发原因\|补发类型\|业务类型\)[\s\S]*'快递责任补发'/,
  'OMS reissue creation must recognize the live “补发原因” field and legacy aliases');
assert.match(omsReissueAdapter, /following-sibling[\s\S]*timeoutMs = 30_000[\s\S]*等待 \$\{timeoutMs\} 毫秒仍未找到/u,
  'OMS reissue reason selection must wait for delayed controls and support sibling field layouts');
assert.match(omsReissueAdapter, /option\.click[\s\S]*singleClickDeadline[\s\S]*waitForSelectedControlValue/u,
  'OMS reissue reason selection must wait for the asynchronous selected value to settle');
assert.match(omsReissueAdapter, /optionRow\.dblclick[\s\S]*waitForSelectedControlValue/u,
  'OMS custom dictionary rows must support double-click commit and verify the selected value');
assert.match(omsReissueAdapter,
  /finalizeCustomPickerSelection[\s\S]*字典弹层未关闭[\s\S]*关闭字典弹层后未保持/u,
  'OMS reissue reason selection must close the live dictionary overlay before outer submit');
assert.match(workflow,
  /findOmsFlatBatchReissueDialog[\s\S]*批量补发[\s\S]*assertSingleOmsBatchReissueSelection[\s\S]*已选择\\s\*\(\\d\+\)/u,
  'OMS reissue creation must recognize the live flat batch dialog and require one selected order');
assert.match(workflow,
  /const flatBatchReissueDialog = await findOmsFlatBatchReissueDialog[\s\S]*if \(flatBatchReissueDialog\)[\s\S]*assertSingleOmsBatchReissueSelection[\s\S]*else \{[\s\S]*clickOmsWizardButton\(targetPage, \['下一步'\]\)[\s\S]*guardedExternalEffect\([\s\S]*if \(flatBatchReissueDialog\)[\s\S]*submitOmsFlatBatchReissue/u,
  'flat OMS reissue must bypass legacy next steps and submit only inside the external-effect guard');
assert.match(omsReissueAdapter,
  /submitOmsFlatBatchReissue[\s\S]*browserDialog\.accept[\s\S]*targetPage\.on\('dialog'[\s\S]*\.el-message-box:visible[\s\S]*confirmationClicked = true/u,
  'flat OMS reissue submit must accept native prompts and wait for delayed DOM confirmation');
assert.match(omsReissueAdapter,
  /submitOmsFlatBatchReissue[\s\S]*\.el-dialog__footer[\s\S]*request\.method\(\) === 'GET'[\s\S]*targetPage\.on\('request'[\s\S]*observation\.requests\.length === 0[\s\S]*externalEffectStatus = 'failed'/u,
  'flat OMS reissue submit must prefer the footer action, observe non-GET requests, and fail closed when no submit occurred');
assert.match(workflow,
  /submissionStrategy:[\s\S]*footer-submit-request-observed-v2[\s\S]*guardedExternalEffect\([\s\S]*request:[\s\S]*submissionStrategy/u,
  'the footer/request-observed submission strategy must participate in the guarded request hash');
assert.match(postgresAdapter,
  /exactFailedRetry[\s\S]*effect\.effect_type === 'oms-reissue-create'[\s\S]*hasVerifiedOmsReissueNotAppliedEvidence\(effect\)[\s\S]*reconciledOmsRequestRefresh[\s\S]*effect\?\.request_hash !== requestHash/u,
  'a read-only-proven OMS non-application must not repeat the same request hash and may retry only after the guarded strategy changes');
assert.match(runner,
  /OMS 补发页面未找到按钮: 下一步[\s\S]*fastTransientFailure = \/OMS_QUERY_TEMPORARILY_UNAVAILABLE/,
  'a stale OMS wizard variant must use the bounded fast transient retry path');
assert.match(workflow, /oms-reissue-render-refreshing[\s\S]*targetPage\.reload\([\s\S]*ensureOmsOrderManagementPage/u,
  'OMS reissue creation must refresh and reopen the wizard after a bounded render failure');
assert.match(workflow,
  /omsSalesOrderCodeFromRow[\s\S]*col-id="salesOrderCode"[\s\S]*originalSalesOrderCode/u,
  'OMS reissue creation must capture the original SO code from the sales-order column');
assert.match(workflow,
  /reconcileOmsReissueCreateState[\s\S]*inspectOmsReissueQueryPass[\s\S]*passes\.length === 2[\s\S]*two-pass-exact-oms-order-query-single-original-row/u,
  'unknown OMS reissue creates must use two exact read-only passes before authorizing retry');
assert.match(workflow,
  /reconcileExternalEffectTypes\.has\('oms-reissue-create'\)[\s\S]*reconcileOmsReissueCreateState/u,
  'the resident workflow must route unknown OMS reissue effects to read-only reconciliation');
assert.match(postgresAdapter,
  /effect\.effect_type = 'oms-reissue-create'[\s\S]*effect\.status = 'unknown'[\s\S]*'oms-reissue-create'[\s\S]*const intermediateReconciliation = \[[\s\S]*'oms-reissue-create'/u,
  'OMS reissue reconciliation must be claimable and continue the same ordinary instance');
assert.match(omsReissueAdapter, /concat\(\" \",normalize-space\(@class\),\" \"\),\" el-form-item \"\)/,
  'OMS reissue field lookup must scope the select to the full form item, not its label child');
assert.match(workflow, /ordinary-platform-logistics-update-rejected-reevaluating[\s\S]*rejected-not-applied/,
  'a definitive PDD logistics-update rejection must be persisted for rule re-evaluation');
assert.match(workflow, /extendedOrdinaryWait[\s\S]*ordinaryScenarioExecution: current\.ordinaryScenarioExecution[\s\S]*platformLogisticsUpdateRejection/,
  'extended ordinary waits must retain order-scoped execution facts without retaining a stage success marker');
assert.match(completedDuringOptionSelectionMigration, /ordinaryPddOptionLookupFailure[\s\S]*已完结/);
assert.match(completedDuringOptionSelectionMigration, /reconcile-completed-detail-before-form-retry/);
assert.match(completedDuringOptionSelectionMigration, /effect_type = 'pdd-submit'[\s\S]*status IN \('succeeded', 'unknown'\)/);
assert.match(workflow, /pdd-order-remark-login-recovering/);
assert.match(workflow, /ensurePddLogin\(targetPage, context, recoveryUrl\)/);
assert.match(workflow, /loginRecoveryAttempted: true/);
assert.match(pddOrderRemarkLoginRecoveryMigration, /pdd-order-remark-login-retry-ready/);
assert.match(pddOrderRemarkLoginRecoveryMigration, /effect_type = 'pdd-note'[\s\S]*status IN \('succeeded', 'unknown'\)/);
assert.match(pddOrderRemarkLoginRecoveryMigration, /effect_type = 'pdd-submit'[\s\S]*status IN \('succeeded', 'unknown'\)/);
assert.match(workflow, /targetPage\.frames\(\)[\s\S]*frame !== targetPage\.mainFrame\(\)[\s\S]*frame\.locator\('body'\)/,
  'ordinary PDD option selection must inspect rendered child frames as well as the main document');
assert.match(runner, /\['verification-required', 'login-required', 'rate-limited', 'retryable-error'\][\s\S]{0,80}\.includes\(discoveryStatus\)/);
assert.match(runner, /if \(residentBrowser\) \{\s*return \{\s*mode: 'discovery',\s*status: 'retryable-error'/);
assert.match(runner, /Return-refund \$\{mode\} interrupted/);
assert.match(workflow, /detectHumanVerification/);
assert.match(workflow, /const activateVerificationPage = async[\s\S]*document\.visibilityState[\s\S]*Target\.activateTarget/);
assert.match(workflow, /verificationSystem[\s\S]*const activation = await activateVerificationPage\(targetPage\)[\s\S]*maintainFocus: \(\) => activateVerificationPage\(targetPage\)/);
assert.match(workflow,
  /const activeRefundWork = activeAssignmentId[\s\S]*const activeRefundReconciliation = activeRefundWork[\s\S]*existingEffectStatus[\s\S]*const verificationQueuePriority = !activeAssignmentId[\s\S]*activeRefundWork && !activeRefundReconciliation \? 1 : 0;[\s\S]*verificationFocusCoordinator\.acquire\(\{[\s\S]*priority: verificationQueuePriority/,
  'ordinary, refund, and background work must enter the focus queue in that priority order');
assert.match(workflow,
  /activeRefundWork \? 'active-refund' : 'active-ordinary'/,
  'verification diagnostics must distinguish active ordinary and refund work');
assert.match(workflow, /'active-refund-reconciliation'/,
  'an unresolved refund effect must retain the highest business priority');
assert.match(workflow,
  /priority: verificationQueuePriority,[\s\S]*workClass: verificationWorkClass/,
  'verification progress must expose queue priority and work class');
assert.match(workflow, /status: 'idle'/);
assert.match(workflow, /resetResidentAssignment\(\{ outcome: 'manual-review-blocked' \}\)/);
assert.match(workflow, /for \(let attempt = 1; attempt <= 3; attempt\+\+\)/);
assert.match(workflow, /radio\.check\(\{ force: true \}\)/);
assert.match(workflow, /&& !await selectPddRadio\(targetPage, targetPage\.locator\('body'\), expectedOutcome/);
assert.match(workflow, /const pddPrimaryRefundOutcomeGroup = \[/);
assert.match(workflow, /submitPddResolutionWithRefreshRecovery/);
assert.match(workflow,
  /const waitForVisiblePddPrimaryRefundOutcome = async[\s\S]*selectPddCoreResolutionOption/,
  'equivalent refund outcomes must be rediscovered throughout the bounded render window');
assert.match(workflow,
  /flowCode === 'consumer-negotiation-followup'[\s\S]{0,220}notAppliedRetryAuthorizedAt[\s\S]{0,180}consumer-negotiation-followup-retry-v2/,
  'a proven not-applied consumer follow-up must use a new idempotency stage for its one authorized retry');
assert.match(workflow,
  /const selectPddCoreResolutionOption = async[\s\S]*resolvePddCoreVisibleSelection[\s\S]*selectPddRadio[\s\S]*pddCoreOptionSelection/,
  'core refund, intercept, and negotiation options must use visible semantic judgment with an audit trail');
assert.match(workflow,
  /visibleInterceptProgressOutcomes = \[\.\.\.new Set\([\s\S]*resolveOrdinaryPddSemanticOption[\s\S]*visibleConsumerNegotiationOutcomes = \[\.\.\.new Set\([\s\S]*resolveOrdinaryPddSemanticOption/,
  'renamed intercept-progress and consumer-negotiation controls must still identify the current form branch');
assert.match(workflow,
  /pdd-resolution-controls-retry-ready[\s\S]*PDD_ORDINARY_RESULT_STAGE_TEMPORARILY_UNAVAILABLE/,
  'an unrendered pre-submit result stage must return to the transient queue instead of manual review');
assert.match(workflow,
  /error\?\.code === 'PDD_ORDINARY_SUBMIT_RENDER_TEMPORARILY_UNAVAILABLE'[\s\S]*error\?\.code === 'PDD_ORDINARY_RESULT_STAGE_TEMPORARILY_UNAVAILABLE'\) throw error/,
  'standard refund form render failures must reach the worker retry policy');
assert.match(workflow, /targetPage\.reload\(\{ waitUntil: 'domcontentloaded'/);
assert.match(workflow, /targetPage\.url\(\) === recoveryUrl[\s\S]*targetPage\.reload\(\{ waitUntil: 'commit', timeout: 90000 \}\)/);
assert.match(workflow, /step: 'pdd-resolution-detail-reopening'[\s\S]*await closeDerivedPage\(targetPage\)[\s\S]*普通工单详情恢复列表渲染/u);
assert.match(workflow, /waitForPddRenderedResult\(pddPage[\s\S]*submitPendingOrderQuery\(pddPage, orderNumber, 'resolution'\)/u);
assert.match(workflow, /普通工单详情恢复查询渲染[\s\S]*confirmEmptyAfterRefresh: true/u);
assert.match(workflow, /step: 'pdd-resolution-absent-from-pending-list'/);
assert.match(workflow, /confirmationMethod: queryState\.confirmationMethod \|\| 'two-pass-exact-order-query'/);
assert.match(workflow, /confirmationMethod: 'rendered-exact-order-query'/);
assert.match(workflow, /completedPddStateFromPendingListAbsence/);
assert.match(workflow, /buildPddSubmissionReconciliationObservation/);
assert.match(workflow, /Number\(preSubmitSubmission\.submitAttemptCount \|\| 0\) >= 2/);
assert.match(workflow, /拼多多两次提交均未生效，已禁止第三次提交/);
assert.match(workflow, /submissionForAttempt\.notAppliedRetryAuthorizedAt/);
assert.match(workflow, /'resolution-postcondition-retry-v2'/);
assert.match(workflow, /lastClickAttemptedAt/);
assert.match(workflow, /classifyOrdinaryPddMessageStage/);
assert.match(workflow, /directPrefilledSubmit[\s\S]*submit-prefilled-reply-v1/);
assert.doesNotMatch(workflow,
  /externalActionStartedAt: new Date\(\)\.toISOString\(\),\s*lastClickAttemptedAt:/,
  'ordinary submission progress must not claim a click before form selection reaches the submit button');
assert.match(workflow,
  /const capturePddEvidenceScreenshot[\s\S]*ensurePddResolutionDetailReady\([\s\S]*detailState\.orderMatches/,
  'TMS evidence capture must validate the rendered detail with whole-page order parsing');
assert.doesNotMatch(workflow,
  /const capturePddEvidenceScreenshot[\s\S]{0,500}getByText\(\/\(\?:订单编号\|订单号\)/u,
  'TMS evidence capture must not require the order label and number in one text node');
assert.match(workflow,
  /const bodyText = labelText[\s\S]*parseOrderNumber\(labelText\) \|\| parseOrderNumber\(bodyText\)/,
  'ordinary detail capture must fall back to whole-page text when PDD splits the order label and value');
assert.match(workflow, /class PddSubmitRejectedError extends Error/);
assert.match(workflow, /\/latitude\/mallTicket\/submitForm/);
assert.match(workflow, /externalEffectStatus === 'failed'/);
assert.match(workflow, /effectType: 'evidence-upload'/);
assert.match(workflow, /stage: `pdd-evidence-upload-\$\{actionLabel\}`/);
assert.match(workflow, /const effectStatus = classifyPddEvidenceUploadEffectStatus\(\{[\s\S]*uploadAttempted,[\s\S]*authorizationFailure,[\s\S]*message: error\.message/);
assert.match(workflow, /if \(effectStatus === 'failed'\) error\.externalEffectStatus = 'failed'/);
assert.match(workflow, /status: effectStatus/);
assert.match(workflow, /const shouldOmitOptionalPddEvidence/);
assert.match(workflow, /flowCode === 'subjective-intercept'/);
assert.match(workflow, /const pddSubjectiveDirectRefundOutcome = '同意消费者退款申请'/);
assert.match(workflow,
  /selectPddCoreResolutionOption\([\s\S]{0,320}\[pddSubjectiveDirectRefundOutcome\][\s\S]{0,700}if \(inTransitRefundDecision\)[\s\S]{0,260}flow\.primaryOutcome = subjectiveRefundOutcome[\s\S]{0,180}flow\.tertiaryOutcome = subjectiveRefundOutcome[\s\S]*markTmsEvidenceUnused/,
  '在途无理由退款必须归入固定优先级退款结果，其他主观原因工单仍保留原协商结果');
const subjectiveDirectRefundBranch = workflow.match(
  /let subjectiveRefundOutcome;[\s\S]*?markTmsEvidenceUnused\(decision\.orderNumber, decision\.workOrderType\);/,
)?.[0] || '';
assert.doesNotMatch(subjectiveDirectRefundBranch, /uploadTmsEvidenceToPdd/,
  '直接同意消费者退款申请的分支不得再上传 TMS 凭证');
assert.match(workflow,
  /shouldStartPddConsumerNegotiationWait[\s\S]*pdd-consumer-negotiation-followup-waiting[\s\S]*consumerResponseNextAttemptAt/,
  '快递仍在拦截中的已确认阶段转换必须进入消费者 12 小时等待');
assert.match(subjectiveRefundFallbackRecoveryMigration,
  /subjective-refund-fallback-pause-recovered/);
assert.match(subjectiveRefundFallbackRecoveryMigration,
  /historicalEvidenceRefundFallbackAuthorizedAt/);
assert.match(subjectiveRefundFallbackRecoveryMigration,
  /select-refund-after-pdd-evidence-48143/);
assert.match(workflow, /const completionRecoveryRequested = recoveredExactDetail[\s\S]*pddResolutionSubmission\?\.recoveredFromCompletedPage[\s\S]*completedPageArchiveRecovery/);
assert.match(workflow, /if \(completionRecoveryRequested && requestedOrderNumber\)[\s\S]*runPddResolutionWorkflow\(detailPage, requestedOrderNumber\)[\s\S]*archiveAndResetCompletedOrder\(completion\)/);
assert.match(workflow, /PDD_UNSHIPPED_RETRY_MS \|\| '600000'/);
assert.doesNotMatch(workflow, /submitAttemptCount: Math\.max\([\s\S]{0,160}\) \+ 1,/);
assert.match(legacyRuntimeRecoveryMigration, /stale-processing-recovered/);
assert.match(legacyRuntimeRecoveryMigration, /current_step = 'logistics-waiting-released'/);
assert.match(legacyRuntimeRecoveryMigration, /pdd-upload-authorization-retry-ready/);
assert.match(legacyRuntimeRecoveryMigration, /flow-pause-reason-restored/);
assert.match(legacyRuntimeRecoveryMigration, /work_order\.payload #>> '\{omsAnalysis,orderStatus\}' = '已配货'/);
assert.match(dataBackend, /evidence\?\.actualSubmitAttemptCount/);
assert.match(dataBackend, /effect_type = 'pdd-submit'[\s\S]*status IN \('unknown', 'succeeded'\)/);
assert.match(dataBackend, /idempotency_key LIKE '%:resolution-postcondition-retry-v2'/);
assert.match(workflow, /handover-absent-from-pending-list/);
assert.match(workflow, /WORKFLOW_CLEAR_FOREIGN_PROFILE_LOCK/);
assert.match(dataBackend, /operationalReasonCodes = new Set\(\['waiting-logistics', 'rate-limited'\]\)/);
assert.match(dataBackend,
  /transientInterventionReasonCodes = new Set\(\[[\s\S]{0,320}'page-render-deferred'/,
  'page render deferrals must remain transient and self-clearing');
assert.match(dataBackend,
  /operationalReasonCodes\.has\(raw\.reasonCode\)[\s\S]{0,120}\? \[\.\.\.transientInterventionReasonCodes\]/,
  'a later operational wait must clear superseded transient interventions');
assert.match(dataBackend,
  /!nonActionableManualInterventionReasonCodes\.includes\(raw\.reasonCode\)/,
  'automatic retry and authentication assistance must not create actionable manual interventions');
assert.match(dataBackend,
  /includeNonActionable[\s\S]{0,500}coalesce\(i\.reason_code, ''\) <> ALL/,
  'the manual intervention API must hide non-actionable retry and authentication waits by default');
assert.match(dataBackend, /idempotency_key LIKE 'pdd-discovered:%'/);
assert.match(staging, /WORKER_MAX_ORDERS: \$\{WORKER_MAX_ORDERS:-0\}/);
assert.match(staging, /OMS_MODE: \$\{OMS_MODE:-per-shop\}/);
assert.match(production, /OMS_MODE: \$\{OMS_MODE:-per-shop\}/);
assert.match(runner, /OMS_MODE: omsMode/);
assert.match(staging, /init: true/);
assert.match(dynamicSupervisor, /const reusableDesktops = new Map\(\)/);
assert.match(dynamicSupervisor, /WHERE id NOT LIKE 'scheduler-test-%'/,
  'the live supervisor must never launch PostgreSQL scheduler test fixtures');
assert.match(dynamicSupervisor, /const maxShops = Number\.isFinite\(configuredMaxShops\)[\s\S]*: null/);
assert.match(dynamicSupervisor, /const desired = maxShops == null \? enabled : enabled\.slice\(0, maxShops\)/);
assert.match(dynamicSupervisor,
  /WORKER_SUPERVISOR_START_STAGGER_MS[\s\S]*startAttemptsThisPass > 0[\s\S]*await delay\(startStaggerMs\)/,
  'dynamic shop cold starts must be staggered without imposing a shop-count limit');
assert.match(dataBackend, /const maxEnabledShops = Number\.isFinite\(configuredMaxEnabledShops\)[\s\S]*: null/);
assert.match(dataBackend, /unlimited: maxEnabledShops == null/);
assert.doesNotMatch(shopsView, /disabled=\{!editing && !hasWorkerCapacity\}/);
assert.match(shopsView, /shop\?\.enabled \?\? true/);
assert.match(dynamicSupervisor, /browserRecovery \|\| cleanExit[\s\S]{0,40}\? 500/);
assert.match(dynamicSupervisor,
  /const cleanExit = code === 0 && !signal[\s\S]{0,220}browserRecovery \|\| cleanExit[\s\S]{0,80}\? 500/,
  'a clean shop-runner exit must restart immediately without exponential failure backoff');
assert.match(dynamicSupervisor, /if \(!cleanExit\) \{[\s\S]{0,320}UPDATE shops SET onboarding_status/,
  'a clean shop-runner exit must not overwrite the live onboarding state with a false error');
assert.match(dynamicSupervisor, /retryDelay \+ 50/);
assert.match(dynamicSupervisor,
  /spawn\('taskkill\.exe', \['\/PID', String\(pid\), '\/T', '\/F'\]/,
  'a timed-out Windows shop runner must be removed with its workflow and Chromium descendants');
assert.match(dynamicSupervisor,
  /windowsNative && child\.connected[\s\S]{0,180}child\.send\(\{ type: 'shutdown' \}/,
  'Windows shop reloads must request an IPC shutdown before using process-tree cleanup');
assert.match(dynamicSupervisor,
  /const childrenToStop = \[\][\s\S]*childrenToStop\.push\([\s\S]*await Promise\.all\(childrenToStop\.map\(async[\s\S]*await stopChild/,
  'independent shop reloads must drain concurrently instead of multiplying the safety timeout');
assert.match(dynamicSupervisor,
  /stdio: \['inherit', 'inherit', 'inherit', 'ipc'\][\s\S]{0,100}serialization: 'json'/,
  'dynamic shop runners must expose an IPC control channel for graceful shutdown');
assert.match(dynamicSupervisor, /preserveDesktop && !desktopExited\(entry\.desktop\)/);
assert.match(dynamicSupervisor, /reusing \$\{shop\.id\} desktop/);
assert.match(dynamicSupervisor, /远程桌面已连接/);
assert.match(nativeEnv, /WORKER_SUPERVISOR_START_STAGGER_MS=5000/);
assert.match(dataBackend, /reconnect=true&reconnect_delay=1000/);
assert.match(dataBackend, /WORKER_EVENT_ONLY_SOURCE_IDS \|\| 'windows-native'/);
assert.match(apiMain, /refresh-next-order/);
assert.match(apiMain, /verifications\/:id\/refresh-next/);
assert.match(apiMain, /verifications\/:id\/force-clear/);
assert.match(dataBackend, /requestVerificationRefreshNext/);
assert.match(dataBackend, /requestVerificationForceClear/);
assert.match(verificationView, /刷新并切下一单/);
assert.match(verificationView, /强制解除并继续/);
assert.match(runner, /'force-clear-verification'/);
assert.match(runner, /operator-verification-force-cleared/);
assert.match(runner, /commandTypes: \[[\s\S]*'verification-recheck'[\s\S]*'force-clear-verification'[\s\S]*\]/);
assert.match(runner, /sendRuntimeControl\(\{ action: 'refresh-active-page' \}\)/);
assert.match(runner, /handoffActiveClaim/);
assert.match(postgresAdapter, /async handoffClaimed/);
assert.match(postgresAdapter, /pdd-order-remark\.\*locator\\\.click: Timeout/);
assert.match(postgresAdapter, /status = 'unknown'/);
assert.match(postgresAdapter, /recovery_reason = CASE WHEN \$7::int > 0 THEN 'unknown-external-effect'/);
assert.match(workflow, /\['refresh-active-page', 'refresh-pdd-identity', 'focus-system-login'\]\.includes\(message\.action\)/);
assert.match(workflow,
  /message\.action === 'focus-system-login'[\s\S]*\['oms', 'tms'\]\.includes\(system\)[\s\S]*system === 'tms'[\s\S]*ensureTmsLoginOnce\(targetPage, context\)[\s\S]*maybeBringToFront\(targetPage, \{ manual: true, force: true \}\)/,
  'only an explicit owner system-login command may force the selected OMS or TMS tab to the foreground');
assert.match(workflow,
  /clearTmsDynamicTransportSecurityPolicy[\s\S]*tms-transport-security-recovery[\s\S]*chrome:\/\/net-internals\/#hsts[\s\S]*domain-security-policy-view-delete-input/,
  'TMS network-error recovery must clear only the stale dynamic HSTS policy');
assert.match(workflow,
  /navigationNetworkFailure = isBrowserNetworkErrorUrl\(observedUrl\)[\s\S]*ERR_\[A-Z0-9_\][\s\S]*targetIsTms[\s\S]*clearTmsDynamicTransportSecurityPolicy\(\)[\s\S]*TMS_NAVIGATION_TEMPORARILY_UNAVAILABLE/,
  'browser network error pages must never be accepted as a slowly rendered TMS page');
assert.match(runner,
  /TMS_NAVIGATION_TEMPORARILY_UNAVAILABLE[\s\S]*TMS_\(\?:ATTACHMENT_UPLOAD\|NAVIGATION\)_TEMPORARILY_UNAVAILABLE/,
  'TMS navigation outages must use the short transient retry queue instead of permanent pause');
assert.match(workflow,
  /isSystemLoginUrl\(system, targetPage\.url\(\)\)[\s\S]*updateAuthHealth\(system, 'expired'[\s\S]*source: 'owner-login-request'/,
  'an initial OMS login must enter an observable login-required state');
assert.match(workflow,
  /isAuthenticatedSystemUrl\(system, targetPage\.url\(\)\)[\s\S]*confirmOmsBusinessPage[\s\S]*updateAuthHealth\(system, 'authenticated'[\s\S]*persistBrowserAuth/,
  'a completed OMS login must confirm the rendered business session and persist the per-shop profile');
assert.match(workflow,
  /system === 'oms'[\s\S]{0,180}process\.env\.JEOMS_ACCOUNT[\s\S]{0,180}process\.env\.JEOMS_PASSWORD[\s\S]{0,260}ensureOmsLogin/,
  'an OMS login command must use configured per-shop credentials instead of only opening the login page');
assert.match(shopsView,
  /ShopInitializationModal[\s\S]*打开拼多多登录[\s\S]*打开 OMS 登录/,
  'new shops must expose an ordered PDD and OMS first-login flow');
assert.match(shopsView,
  /setInterval\(refresh, 3000\)[\s\S]*初始化登录/,
  'shop onboarding must refresh authentication state while the operator logs in');
assert.match(publicApp,
  /const byCode = new Map[\s\S]*const definitions = \(scenarios \|\| \[\]\)[\s\S]*total: 0[\s\S]*autoSuccess: 0/,
  'the public dashboard must retain every configured scenario even when the selected date range has no rows');
assert.match(publicWorkOrderDrawer,
  /primaryReturnRefund[\s\S]*returnTrackingNumber[\s\S]*latestReturnTrace[\s\S]*退货物流信息/,
  'the public return-refund drawer must promote stored return logistics into the logistics summary');
assert.match(webServer,
  /sanitizePublicRefund[\s\S]*logisticsTimeline[\s\S]*occurredAt: publicDate/,
  'the public sanitizer must expose only bounded, scrubbed return-logistics timeline fields');
assert.match(webServer,
  /decodedRequestPathname[\s\S]*decodeURIComponent[\s\S]*catch \{[\s\S]*return null[\s\S]*rejectMalformedRequestPath/,
  'malformed URL encoding must return a bounded 400 response instead of crashing the public web process');
assert.match(nativeComponentRunner,
  /'Web' \{[\s\S]{0,180}Invoke-RestartingNativeProcess[\s\S]{0,120}apps\/web\/src\/server\.mjs/,
  'the Windows Web component must restart after an unexpected child exit');
assert.match(workflow, /step: 'operator-page-refreshed'/);
assert.match(workflow, /targetPage\.on\('framenavigated', recordPddManualRefresh\)/);
assert.match(workflow, /trigger: 'pdd-manual-refresh'/);
assert.match(
  workflow,
  /step: stillOnPddLogin \? 'manual-login-required' : 'human-verification-completed',[\s\S]*verificationRecovery: null/,
  'a cleared challenge must reset verification backoff for future independent challenges',
);
assert.match(workflow, /updateAuthHealth\(system, 'unknown', page,[\s\S]{0,300}source: 'resident-idle-url-observer'/,
  'login URLs without rendered logout proof must remain weak observations');
assert.match(workflow, /const renderedLoginState = system === 'oms'[\s\S]{0,120}readOmsAppState\(page\)/,
  'the idle observer must inspect the rendered OMS login state after a stable login URL');
assert.match(workflow, /renderedLoginConfirmed[\s\S]{0,700}updateAuthHealth\(system, 'expired', page,[\s\S]{0,220}source: 'resident-idle-dom-observer'[\s\S]{0,180}'rendered-login-form'/,
  'a rendered OMS login form must replace stale authenticated health with confirmed expiry');
assert.match(workflow, /status === 'authenticated'[\s\S]{0,120}isBrowserNetworkErrorUrl\(observedUrl\)/,
  'an authenticated observation must be rejected when Chromium is displaying a network error page');
assert.match(workflow, /source: 'controlled-workflow-connectivity-check'[\s\S]{0,120}evidence: 'browser-network-error-page'/,
  'network error pages must be persisted as confirmed connectivity failures');
assert.match(workflow, /effectiveStatus === 'authenticated' \? \{ manualReview: null, error: null \} : \{\}/,
  'a connectivity failure must preserve current error and manual-review evidence');
assert.match(workflow, /const legacyWeakExpiry = health\?\.status === 'expired'[\s\S]{0,120}isWeakAuthHealthEvidence\(health\)/,
  'the idle observer must heal legacy URL-only expiry state after a rolling reload');
assert.match(workflow, /!isAuthenticatedSystemUrl\(system, url\)[\s\S]{0,360}evidence: url === 'about:blank' \? 'about:blank' : 'unprobed-page'/,
  'blank or unprobed idle anchors must be weak unknown observations, never expired sessions');
assert.doesNotMatch(workflow, /updateAuthHealth\(system, 'expired', page, \{ stage: `\$\{system\}-idle-session-observer` \}\)/,
  'the idle observer must not overwrite a confirmed session from the URL alone');
assert.match(workflow, /authHealth\.pdd = mergeSystemAuthHealth\(authHealth\.pdd,[\s\S]{0,260}source: 'resident-discovery-reset'/,
  'discovery cleanup must not downgrade a previously confirmed PDD session');
assert.match(workflow, /WORKFLOW_HUMAN_VERIFICATION_CLEAR_STABLE_MS \|\| '3000'/);
assert.match(workflow, /const reusable = existing[\s\S]*existing\.url === currentUrl/);
assert.match(workflow, /id: reusable \? existing\.id : crypto\.randomUUID\(\)/);
assert.match(workflow, /const verifiedPddDetailRecoveryUrl/);
assert.match(workflow, /verified-detail-recovered-after-pending-miss/);
assert.match(workflow, /if \(recoveredState\.isCompleted && recoveredState\.orderMatches\)/);
assert.match(workflow, /stage: '指定普通工单查询渲染'/);
assert.match(workflow, /onRefresh: \(page\) => submitPendingOrderQuery\(/);
assert.match(workflow, /confirmEmptyAfterRefresh: true/);
assert.match(workflow, /refreshOnInitialResult: confirmEmptyAfterRefresh/);
assert.match(workflow, /step: 'requested-order-pending-absence-confirmed'/);
assert.match(workflow, /目标工单查询为空，但尚未取得刷新后的精确零结果/);
assert.match(runner, /拼多多指定普通工单查询渲染刷新后等待/);
assert.match(legacyPendingRenderRecoveryMigration, /legacy-pending-render-pause-recovered/);
assert.match(legacyPendingRenderRecoveryMigration, /pddIdentityBindingToken/);
assert.match(legacyPendingRenderRecoveryMigration, /identity_status IN \('verified', 'legacy-unverified'\)/);
assert.match(legacyPendingRenderRecoveryMigration, /effect\.status IN \('reserved','unknown'\)/);
assert.match(unrefreshedEmptyRecoveryMigration, /unrefreshed-empty-pending-pause-recovered/);
assert.match(unrefreshedEmptyRecoveryMigration, /ordinaryPendingListPresence/);
assert.match(unrefreshedEmptyRecoveryMigration, /->>'refreshed' = 'false'/);
assert.match(mismatchedExistingTmsDecisionRecoveryMigration, /mismatched-existing-tms-decision-recovered/);
assert.match(mismatchedExistingTmsDecisionRecoveryMigration, /effect\.effect_type = 'tms-create'/);
assert.match(mismatchedExistingTmsDecisionRecoveryMigration, /effect\.status = 'succeeded'/);
assert.match(runner, /const authoritativeRecoveryPayload = Boolean\(/);
assert.match(runner, /mismatchedExistingTmsDecisionRecoveryReapplied/);
assert.match(runner, /interceptProgressFollowupRecovery/);
assert.match(runner, /consumerNegotiationFollowupRecovery/);
assert.match(runner, /refreshedRequestedOrderAbsenceRecovery/);
assert.match(runner, /postgres-authoritative-recovery/);
assert.match(workflow,
  /ordinary-tms-stage-reused[\s\S]*externalActionsReplayed: false/,
  'a completed ordinary TMS stage must be reused without replaying OMS or TMS actions');
assert.match(
  postgresAdapter,
  /const recoveryIdentityConfirmed = recoverySource === 'exact-instance-completion-marker'[\s\S]{0,120}\|\| currentIdentityComplete/,
  'startup reconciliation must accept an exact legacy instance completion marker without inventing PDD platform ids',
);
assert.match(reappliedMismatchedTmsDecisionRecoveryMigration, /postgres-payload-overrides-local-checkpoint/);
assert.match(reappliedMismatchedTmsDecisionRecoveryMigration, /effect\.status = 'succeeded'/);
assert.match(consumerNegotiationFollowupRecoveryMigration, /work_order\.status IN \('paused', 'retry-ready'\)/);
assert.match(consumerNegotiationFollowupRecoveryMigration, /请填写和消费者协商处理结果/u);
assert.match(consumerNegotiationFollowupRecoveryMigration, /UPDATE external_effects effect/);
assert.match(consumerNegotiationFollowupRecoveryMigration, /consumerNegotiationFollowupRecovery/);
assert.match(consumerNegotiationFollowupRecoveryMigration, /current_step = 'logistics-waiting-released'/);
assert.match(consumerNegotiationFollowupRecoveryMigration, /first_stage_effects\.completed_at/);
assert.match(consumerNegotiationFollowupRecoveryMigration, /'orderNumber', candidate\.external_order_number/);
assert.match(consumerNegotiationFollowupRecoveryMigration, /'outcome', '快递还在拦截中'/u);
assert.match(consumerNegotiationFollowupRecoveryMigration, /pddResolutionSubmission'->>'orderNumber' IS NULL/);
assert.match(terminalReturnRefundRecoveryMigration, /return-refund-terminal-reconciliation-ready/);
assert.match(terminalReturnRefundRecoveryMigration, /refund\.action_state = 'manual-review'/);
assert.match(terminalReturnRefundRecoveryMigration, /SET action_state = 'manual-review'/);
assert.match(terminalReturnRefundRecoveryMigration, /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(terminalReturnRefundRecoveryMigration, /return-refund-terminal-review-recovered/);
assert.match(ordinaryFirstDiscoveredRecoveryMigration, /ordinary-first-discovered-pause-recovered/);
assert.match(ordinaryFirstDiscoveredRecoveryMigration, /instance\.first_discovered_at IS NOT NULL/);
assert.match(ordinaryFirstDiscoveredRecoveryMigration, /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(ordinaryFirstDiscoveredRecoveryMigration, /runtime\.lease_expires_at > now\(\)/);
assert.match(workflow, /const matchCarrierCategories = \(value\) =>[\s\S]*explicitlyPostal[\s\S]*key === 'postal'/);
assert.match(workflow, /matchCarrierCategories\('菜鸟邮政'\)[\s\S]*carrierMatchesRecommendation\('菜鸟邮政', '邮政快递包裹'\)/u);
assert.match(runner, /payload\.tmsPostalCarrierAliasRecovery/);
assert.match(workflow, /Boolean\(readProgress\(\)\.tmsPostalCarrierAliasRecovery\)/);
assert.match(workflow, /completionRecoveryRequested[\s\S]*reopenPddDetailForResolution[\s\S]*hasConfirmedPendingListAbsence/);
assert.match(workflow, /pddResolutionPendingListPresence\.refreshed === true[\s\S]*'two-pass-exact-order-query'[\s\S]*'exact-order-zero-result'/);
assert.match(tmsPostalCarrierAliasRecoveryMigration, /tms-postal-carrier-alias-pause-recovered/);
assert.match(tmsPostalCarrierAliasRecoveryMigration, /actual,carrier[\s\S]*菜鸟/u);
assert.match(tmsPostalCarrierAliasRecoveryMigration, /effect\.effect_type = 'tms-create'[\s\S]*effect\.status = 'succeeded'/);
assert.match(tmsPostalCarrierAliasRecoveryMigration, /runtime\.lease_expires_at > now\(\)/);
assert.match(refreshedExactEmptyRecoveryMigration, /refreshed-exact-empty-completion-pause-recovered/);
assert.match(refreshedExactEmptyRecoveryMigration, /pddResolutionPendingListPresence,refreshed/);
assert.match(refreshedExactEmptyRecoveryMigration, /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(refreshedExactEmptyRecoveryMigration, /runtime\.lease_expires_at > now\(\)/);
assert.match(workflow, /canDiscardRecoveredCompletionOrphanEvidence\(progress, completion\)/);
assert.match(workflow, /discardRecoveredCompletionOrphanEvidence\(orderNumber, completion\)/);
assert.match(recoveredCompletionEvidenceCleanupMigration, /completed-orphan-evidence-pause-recovered/);
assert.match(recoveredCompletionEvidenceCleanupMigration, /pddResolutionPendingListPresence,refreshed/);
assert.match(recoveredCompletionEvidenceCleanupMigration, /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(recoveredCompletionEvidenceCleanupMigration, /runtime\.lease_expires_at > now\(\)/);
assert.match(workflow, /recoveredFromCompletedPage: completion\.recoveredFromCompletedPage === true/);
assert.match(dataBackend, /lastCompletedOrder'->>'recoveredFromCompletedPage'/);
assert.match(recoveredCompletionMetricMarkerMigration, /recovered-completion-metric-marker-backfilled/);
assert.match(recoveredCompletionMetricMarkerMigration, /tms-postal-carrier-alias-pause-recovered/);
assert.match(noLogisticsReturnRefundRecoveryMigration, /return-refund-no-logistics-review-recovered/);
assert.match(noLogisticsReturnRefundRecoveryMigration, /refund\.action_button_visible = true/);
assert.match(noLogisticsReturnRefundRecoveryMigration, /refund\.refund_amount < 500/);
assert.match(noLogisticsReturnRefundRecoveryMigration, /effect\.effect_type = 'pdd-return-refund'/);
assert.match(noLogisticsReturnRefundRecoveryMigration, /runtime\.lease_expires_at > now\(\)/);
assert.match(actionableReturnRefundRecoveryMigration, /return-refund-actionable-review-recovered/);
assert.match(actionableReturnRefundRecoveryMigration, /work_order\.status IN \('paused', 'retry-ready'\)/);
assert.match(actionableReturnRefundRecoveryMigration, /refund\.action_button_visible = true/);
assert.match(actionableReturnRefundRecoveryMigration, /refund\.refund_amount < 500/);
assert.match(actionableReturnRefundRecoveryMigration, /effect\.effect_type = 'pdd-return-refund'/);
assert.match(actionableReturnRefundRecoveryMigration, /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(actionableReturnRefundRecoveryMigration, /return-refund-terminal-review-recovered-113/);
assert.match(actionableReturnRefundRecoveryMigration, /runtime\.lease_expires_at > now\(\)/);
assert.match(returnRefundStatusKeywordRecoveryMigration,
  /售后状态不包含%待商家/u);
assert.match(returnRefundStatusKeywordRecoveryMigration,
  /decision = 'policy-recheck-required'/u);
assert.match(returnRefundStatusKeywordRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown', 'succeeded'\)/u);
assert.match(returnRefundStatusKeywordRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/u);
assert.match(returnRefundStatusKeywordRecoveryMigration,
  /live-page-policy-recheck/u);
assert.match(returnRefundAgingPolicyRecoveryMigration, /return-refund-aging-policy-review-recovered/);
assert.match(returnRefundAgingPolicyRecoveryMigration, /refund\.aftersale_status, ''\) LIKE '%待商家%'/);
assert.match(returnRefundAgingPolicyRecoveryMigration, /refund\.refund_amount < 500/);
assert.match(returnRefundAgingPolicyRecoveryMigration, /effect\.effect_type = 'pdd-return-refund'/);
assert.match(returnRefundAgingPolicyRecoveryMigration, /live-rule-recheck-before-auto-refund/);
assert.match(returnRefundRenderTimeoutRecoveryMigration, /return-refund-render-timeout-reclassified/);
assert.match(returnRefundRenderTimeoutRecoveryMigration, /NOT EXISTS \(\s*SELECT 1 FROM external_effects/);
assert.match(returnRefundRenderTimeoutRecoveryMigration, /verification\.status = 'waiting-human'/);
assert.match(returnRefundRenderTimeoutRecoveryMigration, /retry-live-detail-without-verification/);
assert.match(terminalReturnRefundWithoutTypeRecoveryMigration, /return-refund-terminal-without-type-recovered/);
assert.match(terminalReturnRefundWithoutTypeRecoveryMigration, /refund\.action_button_visible = false/);
assert.match(terminalReturnRefundWithoutTypeRecoveryMigration, /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(terminalReturnRefundWithoutTypeRecoveryMigration, /runtime\.lease_expires_at > now\(\)/);
assert.match(standaloneTerminalReturnRefundRecoveryMigration,
  /return-refund-standalone-terminal-recovered/);
assert.match(standaloneTerminalReturnRefundRecoveryMigration,
  /btrim\(refund\.aftersale_status\) = ANY/);
assert.match(standaloneTerminalReturnRefundRecoveryMigration,
  /refund\.action_button_visible = false/);
assert.match(standaloneTerminalReturnRefundRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(standaloneTerminalReturnRefundRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(readOnlyReturnRefundClassificationMigration,
  /readonly-return-refund-classified-automated/);
assert.match(readOnlyReturnRefundClassificationMigration,
  /return-refund-read-only-page-completed/);
assert.match(readOnlyReturnRefundClassificationMigration,
  /handling_classification = 'automated'/);
assert.match(returnRefund, /no-logistics-over-72-hours-action-unavailable/);
assert.match(returnRefund, /nowMs \+ RETURN_REFUND_WAIT_RECHECK_MS/);
assert.match(unavailableRefundActionRecoveryMigration,
  /return-refund-unavailable-action-recovered/);
assert.match(unavailableRefundActionRecoveryMigration,
  /refund\.action_button_visible = false/);
assert.match(unavailableRefundActionRecoveryMigration,
  /periodic-read-only-recheck/);
assert.match(workflow, /ordinaryPddDecisionEntryPattern/);
assert.match(workflow, /立即处理\|我已知晓\|处理工单/);
assert.match(workflow, /const shouldOmitOrdinaryRecallEvidence = \(\) => false/);
assert.match(workflow, /maximumAutomaticSubmitAttempts/);
assert.match(workflow,
  /class PddSubmitButtonRenderError[\s\S]*externalEffectStatus = 'failed'[\s\S]*clickAttempted: false/);
assert.match(workflow,
  /waitForPddSubmitButton = async \([\s\S]{0,180}selectedPddOption = null/);
assert.match(workflow,
  /const submit = await waitForPddSubmitButton\([\s\S]{0,220}\{ selectedPddOption \}[\s\S]*verifyPddSubmitSelections\([\s\S]*if \(beforeClick\) await beforeClick\(\);[\s\S]*submit\.click\(\)/);
assert.match(workflow,
  /belongsToSelectedOptionForm[\s\S]*selected-option-form[\s\S]*never fall back to an[\s\S]*unrelated main-document button/,
  'PDD submit must stay bound to the selected option form, including child frames');
assert.match(workflow,
  /allowTrustedConfirmation[\s\S]*findTrustedPddSubmitConfirmation[\s\S]*confirmation\.button\.click\(\)/,
  'ordinary PDD submit may confirm only a trusted dialog associated with the selected result');
assert.match(workflow,
  /resolveOrdinaryPddSubmitEffectStage[\s\S]*ordinaryPddFrameSubmitRecovery239[\s\S]*migration-239[\s\S]*frame-submit-v3[\s\S]*ordinaryPddFormValidationRecovery263[\s\S]*migration-263[\s\S]*form-validation-v2[\s\S]*unknownEffectRetried !== false/,
  'only exact inspected recoveries may authorize distinct third-attempt idempotency stages');
assert.match(workflow,
  /previousSubmitAttemptCount >= 2 && !oneTimeSubmitRetryAuthorized[\s\S]*禁止第三次提交/u,
  'all ordinary third submits except the exact frame-bound recovery must remain blocked');
assert.match(workflow,
  /const submissionAfterAction = readProgress\(\)\.pddResolutionSubmission;[\s\S]{0,160}!oneTimeSubmitRetryAuthorized/,
  'ordinary submit completion must use the in-scope one-time retry authorization flag');
assert.doesNotMatch(workflow, /\bframeSubmitRetryAuthorized\b|\bretryAuthorized\b/,
  'ordinary submit completion must not reference removed retry authorization variables');
assert.match(workflow,
  /ordinaryPddInterruptedSubmitRecovery264[\s\S]*externalStateReconciliation[\s\S]*interruptedRecovery\.source === 'migration-264'[\s\S]*reconciliation\.state === 'not-applied'[\s\S]*present-in-pending-list[\s\S]*submission\.status === 'retry-authorized'/,
  'an interrupted migration-263 retry may advance only after exact read-only pending proof');
assert.match(proactiveIframeFinalSubmitRecoveryMigration,
  /260810-655664167331689[\s\S]*260814-043421570680710[\s\S]*260817-295866274161800/,
  'migration 239 must target only the three inspected proactive-logistics orders');
assert.match(proactiveIframeFinalSubmitRecoveryMigration,
  /instance\.platform_case_id = expected\.platform_case_id[\s\S]*instance\.identity_status = 'verified'/,
  'migration 239 must bind the exact verified PDD instance');
assert.match(proactiveIframeFinalSubmitRecoveryMigration,
  /scenario_code = 'proactive-logistics-service'[\s\S]*pddResolutionSubmission,selectedOption\}' =\s*'无法确认快递单号'/u,
  'migration 239 must bind exact instance identity, scenario, and final result');
assert.match(proactiveIframeFinalSubmitRecoveryMigration,
  /primary_effect\.status = 'succeeded'[\s\S]*result_effect\.status = 'succeeded'[\s\S]*submitReceipt,success\}' = 'true'[\s\S]*latitude\/mallTicket\/submitForm/,
  'migration 239 must prove both preceding PDD stages succeeded with a business submit receipt');
assert.match(proactiveIframeFinalSubmitRecoveryMigration,
  /6 <= \([\s\S]*confirmedNotApplied\}' = 'true'[\s\S]*present-in-pending-list[\s\S]*lease_expires_at > now\(\)/,
  'migration 239 must require six not-applied observations and no active lease');
assert.match(proactiveIframeFinalSubmitRecoveryMigration,
  /SET status = 'failed'[\s\S]*PDD_WRONG_DOCUMENT_SUBMIT_CONFIRMED_NOT_APPLIED[\s\S]*unknownEffectRetried', false/,
  'migration 239 must close the old unknown effect as confirmed not applied');
assert.match(proactiveIframeFinalSubmitRecoveryMigration,
  /frame-submit-v3[\s\S]*frame-submit-retry-authorized[\s\S]*maximumAutomaticSubmitAttempts', 3/,
  'migration 239 must close the old unknown effect and issue a distinct one-time retry stage');
assert.match(deliveredContactDateValidationRecoveryMigration,
  /260823-585912881472561[\s\S]*1dd0cbdf-32a6-48e5-8771-95cede4c91b2[\s\S]*500013050641440[\s\S]*0228b005-eda8-4ac5-85fc-c447b58aa538/,
  'migration 263 must target only the inspected delivered-not-received instance and effect');
assert.match(deliveredContactDateValidationRecoveryMigration,
  /scenario_code = 'delivered-not-received'[\s\S]*instance\.identity_status = 'verified'/,
  'migration 263 must bind the exact scenario and verified instance');
assert.match(deliveredContactDateValidationRecoveryMigration,
  /binding\.actual_shop_name = shop\.expected_shop_name[\s\S]*binding\.binding_token::text/,
  'migration 263 must bind the current PDD shop identity token');
assert.match(deliveredContactDateValidationRecoveryMigration,
  /receipt->>'clickAttempted' = 'true'[\s\S]*receipt->>'requestCaptured' = 'false'[\s\S]*receipt->>'responseCaptured' = 'false'[\s\S]*btnSubmit\.fail[\s\S]*DatePicker2/,
  'migration 263 must prove that PDD form validation blocked both business requests');
assert.match(deliveredContactDateValidationRecoveryMigration,
  /confirmedNotApplied\}' =\s*'true'[\s\S]*present-in-pending-list[\s\S]*effect\.status IN \('reserved', 'unknown'\)[\s\S]*lease_expires_at > now\(\)/,
  'migration 263 must require the same pending detail, no competing unknown effect, and no active lease');
assert.match(deliveredContactDateValidationRecoveryMigration,
  /SET status = 'failed'[\s\S]*PDD_FORM_VALIDATION_REJECTED_CONFIRMED_NOT_APPLIED[\s\S]*form-validation-retry-authorized[\s\S]*maximumAutomaticSubmitAttempts', 3/,
  'migration 263 must close the false unknown effect and issue one distinct corrected retry');
assert.match(deliveredContactDateValidationRecoveryMigration,
  /original_effect_stage \|\| '-form-validation-v2' AS retry_effect_stage/,
  'migration 263 must use a distinct idempotency stage for the corrected retry');
assert.match(deliveredContactDateValidationRecoveryMigration,
  /externalActionsReplayedByMigration', false[\s\S]*pdd-submit-reconciliation-exhausted[\s\S]*263_recover_delivered_contact_date_validation\.sql/,
  'migration 263 must avoid replaying prior systems, resolve the exact intervention, and record its version');
assert.match(interruptedContactDateRetryReconciliationMigration,
  /260823-585912881472561[\s\S]*1dd0cbdf-32a6-48e5-8771-95cede4c91b2[\s\S]*500013050641440[\s\S]*0228b005-eda8-4ac5-85fc-c447b58aa538/,
  'migration 264 must target only the interrupted migration-263 order, instance, and effect');
assert.match(interruptedContactDateRetryReconciliationMigration,
  /effect\.status = 'reserved'[\s\S]*effect\.receipt IS NULL[\s\S]*effect\.error IS NULL[\s\S]*submitAttemptCount\}' = '1'[\s\S]*lastClickAttemptedAt\}'\s*IS NOT NULL/,
  'migration 264 must require one interrupted click with an empty durable outcome');
assert.match(interruptedContactDateRetryReconciliationMigration,
  /audit\.actor_id = 'migration-263'[\s\S]*delivered-contact-date-validation-retry-ready[\s\S]*schema_migrations[\s\S]*263_recover_delivered_contact_date_validation\.sql/,
  'migration 264 must require the exact prior migration audit and schema version');
assert.match(interruptedContactDateRetryReconciliationMigration,
  /lease_expires_at > now\(\)[\s\S]*SET status = 'unknown'[\s\S]*outcomeCaptureInterrupted'[\s\S]*current_step = 'external-state-reconciliation-ready'/,
  'migration 264 must wait for lease expiry and schedule an unknown click for read-only reconciliation');
assert.match(interruptedContactDateRetryReconciliationMigration,
  /read-only-pdd-detail-before-any-resubmit[\s\S]*externalActionsReplayedByMigration', false[\s\S]*264_reconcile_interrupted_contact_date_retry\.sql/,
  'migration 264 must perform no resubmit and record the read-only recovery version');
assert.equal(
  overlayProductShortageDatePickerRecoveryMigration,
  productShortageDatePickerRecoveryMigration,
  'migration 275 must remain byte-identical in the patch overlay',
);
assert.match(productShortageDatePickerRecoveryMigration,
  /shop-mt9vci3e-20eedf[\s\S]*260803-676037998961915[\s\S]*500013072291819[\s\S]*ordinary-product-shortage-verification-request-v1/,
  'migration 275 must target only the inspected product-shortage instance and stage');
assert.match(productShortageDatePickerRecoveryMigration,
  /scenario_code = 'product-shortage'[\s\S]*instance\.identity_status = 'verified'[\s\S]*binding\.actual_shop_name = shop\.expected_shop_name[\s\S]*binding\.binding_token::text/,
  'migration 275 must bind the exact scenario, verified instance, and current PDD identity');
assert.match(productShortageDatePickerRecoveryMigration,
  /submitAttemptCount\}' = '0'[\s\S]*lastClickAttemptedAt\}'[\s\S]*IS NULL[\s\S]*formFailureConfirmationMethod\}' =\s*'same-order-pending-editable-before-submit'/,
  'migration 275 must require zero submit clicks and durable pre-submit failure proof');
assert.match(productShortageDatePickerRecoveryMigration,
  /effect\.effect_type = 'tms-create'[\s\S]*effect\.status = 'succeeded'[\s\S]*effect\.effect_type = 'pdd-note'[\s\S]*effect\.status = 'succeeded'/,
  'migration 275 must preserve the already successful TMS ticket and PDD note');
assert.match(productShortageDatePickerRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status = 'failed'[\s\S]*clickAttempted' = 'false'[\s\S]*exactPendingEditableDetail\}' =\s*'true'[\s\S]*editableControlCount/,
  'migration 275 must prove the failed PDD effect never clicked and the exact detail remained editable');
assert.match(productShortageDatePickerRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)[\s\S]*effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status = 'succeeded'[\s\S]*lease_expires_at > now\(\)/,
  'migration 275 must exclude unresolved effects, successful PDD submissions, and active leases');
assert.match(productShortageDatePickerRecoveryMigration,
  /reservationAttemptCount', 0[\s\S]*externalActionsReplayedByMigration', false[\s\S]*275_recover_product_shortage_date_picker\.sql/,
  'migration 275 must reset only the form retry budget and record that no external action was replayed');
assert.equal(productShortageDateFrameRecoveryMigration, overlayProductShortageDateFrameRecoveryMigration,
  'migration 276 must stay byte-identical in the root and deployment overlay');
assert.match(productShortageDateFrameRecoveryMigration,
  /shop-mt9vci3e-20eedf[\s\S]*260803-676037998961915[\s\S]*500013072291819[\s\S]*scenario_code = 'product-shortage'/,
  'migration 276 must target only the inspected product-shortage instance');
assert.match(productShortageDateFrameRecoveryMigration,
  /submitAttemptCount\}' = '1'[\s\S]*lastClickAttemptedAt\}'[\s\S]*IS NULL[\s\S]*formFailureConfirmationMethod\}' =\s*'same-order-pending-editable-before-submit'/,
  'migration 276 must require the exact exhausted pre-submit attempt and no click timestamp');
assert.match(productShortageDateFrameRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status = 'failed'[\s\S]*clickAttempted' = 'false'[\s\S]*exactPendingEditableDetail\}' =\s*'true'[\s\S]*editableControlCount/,
  'migration 276 must prove the failed PDD effect never clicked and the same detail remained editable');
assert.match(productShortageDateFrameRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)[\s\S]*effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status = 'succeeded'[\s\S]*lease_expires_at > now\(\)/,
  'migration 276 must exclude unresolved effects, successful PDD submissions, and active leases');
assert.match(productShortageDateFrameRecoveryMigration,
  /submitAttemptCount', 0[\s\S]*reservationAttemptCount', 0[\s\S]*externalActionsReplayedByMigration', false[\s\S]*276_recover_product_shortage_date_frame_lookup\.sql/,
  'migration 276 must reset only proven pre-submit form counters without replaying TMS or PDD actions');
assert.equal(productShortageTmsEffectRecoveryMigration, overlayProductShortageTmsEffectRecoveryMigration,
  'migration 277 must stay byte-identical in the root and deployment overlay');
assert.match(productShortageTmsEffectRecoveryMigration,
  /5b021581-2345-48e4-bf08-00b68a0ee6e8[\s\S]*songteng-yazc-overseas[\s\S]*260823-522285269393952[\s\S]*5f710fc0-f8ac-4070-8eff-2e0387df87f1[\s\S]*500013071007728[\s\S]*c4c803fb-fe04-4907-9911-b487ad86fbec/,
  'migration 277 must target only the inspected work order, instance, case, and identity binding');
assert.match(productShortageTmsEffectRecoveryMigration,
  /ordinary-product-shortage-verification-v1[\s\S]*effect\.status = 'succeeded'[\s\S]*result,data,ticketId\}' = expected\.ticket_id[\s\S]*result,data,ticketNo\}' = expected\.ticket_no[\s\S]*external_ticket_id = expected\.ticket_id[\s\S]*ticketNo' = expected\.ticket_no/,
  'migration 277 must require the exact durable TMS effect receipt and TMS row');
assert.match(productShortageTmsEffectRecoveryMigration,
  /product-shortage-tms-result-recheck-required[\s\S]*omsTmsFlowCompleted\}' =\s*'true'[\s\S]*tmsLookupCompleted\}' =\s*'true'[\s\S]*tmsWorkOrder,ticketId[\s\S]*IS NULL/,
  'migration 277 must prove the progress-loss signature before rehydrating it');
assert.match(productShortageTmsEffectRecoveryMigration,
  /shippingWarehouse\}' ~[\s\S]*筑越仓[\s\S]*shippingWarehouse\}' !~ '久伴体育'/u,
  'migration 277 must preserve the explicit OMS warehouse allowlist and forbidden warehouse rule');
assert.match(productShortageTmsEffectRecoveryMigration,
  /other_effect\.id <> effect\.id[\s\S]*status IN \('reserved', 'unknown'\)[\s\S]*lease_expires_at > now\(\)/,
  'migration 277 must reject other effects, unresolved effects, and active leases');
assert.match(productShortageTmsEffectRecoveryMigration,
  /status = 'retry-ready'[\s\S]*current_step = 'system-shutdown-drained'[\s\S]*系统安全停止 \(supervisor-ipc\)[\s\S]*operatorHandoff,commandType[\s\S]*system-shutdown[\s\S]*loopState,status[\s\S]*shutdown-drained/u,
  'migration 277 may accept only the exact graceful-shutdown handoff produced by the supervisor');
assert.match(productShortageTmsEffectRecoveryMigration,
  /- 'pddEvidenceScreenshot'[\s\S]*- 'tmsEvidenceScreenshot'[\s\S]*'ticketId', candidate\.ticket_id[\s\S]*'ticketNo', candidate\.ticket_no[\s\S]*'omsTmsFlowCompleted', false[\s\S]*'tmsLookupCompleted', false/,
  'migration 277 must rehydrate the committed ticket and require fresh row and evidence verification');
assert.doesNotMatch(productShortageTmsEffectRecoveryMigration,
  /(?:UPDATE|DELETE FROM)\s+external_effects/iu,
  'migration 277 must never rewrite external-effect history');
assert.match(productShortageTmsEffectRecoveryMigration,
  /existingTmsEffectPreserved', true[\s\S]*externalActionsReplayedByMigration', false[\s\S]*277_rehydrate_product_shortage_tms_effect\.sql/,
  'migration 277 must audit that it schedules recovery without replaying an external action');
assert.match(workflow,
  /stableTmsEffectFormDecision[\s\S]*decidedAt: _decidedAt[\s\S]*autoFilledFields: _autoFilledFields[\s\S]*formDecision: stableTmsEffectFormDecision/,
  'TMS idempotency hashing must exclude volatile timestamps and rendered autofill observations');
assert.match(workflow,
  /refreshProductShortageTmsResult[\s\S]*workOrder\?\.status !== 'created'[\s\S]*runOrdinaryTmsAction[\s\S]*ordinary-product-shortage-verification-v1/,
  'a lost product-shortage TMS checkpoint must re-enter the same idempotent TMS stage');
assert.match(visiblePddEvidenceUploadCanaryMigration,
  /260818-411691979192425[\s\S]*shop-mse1sff3-b85aa4[\s\S]*scenario_code = 'intercept-recall'/,
  'migration 240 must target only the inspected visible-upload canary');
assert.match(visiblePddEvidenceUploadCanaryMigration,
  /submitAttemptCount}', '0'\) = '0'[\s\S]*lastClickAttemptedAt}' IS NULL[\s\S]*submit_effect\.receipt IS NULL[\s\S]*jsonb_typeof\(submit_effect\.receipt\) = 'null'/,
  'migration 240 must accept only SQL or JSON null receipts with no submit click');
assert.match(visiblePddEvidenceUploadCanaryMigration,
  /effect\.status IN \('reserved', 'unknown'\)[\s\S]*effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status = 'succeeded'/,
  'migration 240 must exclude unresolved effects and successful PDD submissions');
assert.match(pddEvidenceBucketFallbackCanaryMigration,
  /260820-497664663153578[\s\S]*shop-mse1sff3-b85aa4[\s\S]*instance\.platform_case_id = '500013046044841'[\s\S]*instance\.platform_case_key = 'pdd-work-order:500013046044841'[\s\S]*scenario_code = 'intercept-recall'/,
  'migration 243 must target only the inspected bucket-fallback canary');
assert.match(pddEvidenceBucketFallbackCanaryMigration,
  /uploadInteraction,method\}' =\s*'visible-trigger-filechooser'[\s\S]*authorizationFailure,errorCode\}' =\s*'48143'[\s\S]*submitAttemptCount\}', '0'\) = '0'[\s\S]*lastClickAttemptedAt\}' IS NULL/u,
  'migration 243 must prove the exact 48143 upload and an unclicked PDD submit');
assert.match(pddEvidenceBucketFallbackCanaryMigration,
  /effect_type = 'evidence-upload'[\s\S]*\) = 1[\s\S]*effect_type = 'pdd-submit'[\s\S]*\) = 1[\s\S]*effect\.status IN \('reserved', 'unknown'\)/,
  'migration 243 must require one upload, one submit effect, and no unresolved effects');
assert.match(pddEvidenceBucketFallbackCanaryMigration,
  /work-flow-ticket-48143-to-pdd_mms[\s\S]*243_canary_pdd_evidence_bucket_fallback\.sql/,
  'migration 243 must record the exact compatibility strategy and schema version');
assert.match(pddEvidenceBucketFallbackReceiptRetryMigration,
  /260820-497664663153578[\s\S]*500013046044841[\s\S]*ordinaryEvidenceUpload,status\}' = 'unknown'[\s\S]*file\.pinduoduo\.com\/v3\/store_image[\s\S]*img\.pddpic\.com/u,
  'migration 244 must require exact identity and a valid PDD image receipt');
assert.match(pddEvidenceBucketFallbackReceiptRetryMigration,
  /lastClickAttemptedAt\}' IS NULL[\s\S]*readOnlyReconciliation,state\}' = 'not-applied'[\s\S]*confirmedNotApplied\}' = 'true'/u,
  'migration 244 must prove that the PDD submit was not applied');
assert.match(pddEvidenceBucketFallbackReceiptRetryMigration,
  /actor_id = 'migration-243'[\s\S]*pdd-evidence-bucket-fallback-canary-retry-ready[\s\S]*work-flow-ticket-48143-to-pdd_mms/u,
  'migration 244 must require the exact first-canary audit proof');
assert.match(pddEvidenceBucketFallbackReceiptRetryMigration,
  /status = 'retry-ready'[\s\S]*pdd-evidence-receipt-canary-retry-ready[\s\S]*244_retry_pdd_evidence_bucket_fallback_canary\.sql/u,
  'migration 244 must retain its recovery marker and schema version');
assert.match(pddEvidenceReceiptConfirmationCanaryMigration,
  /d789d628-5c9d-40f3-b631-cc2b0eb3a82a[\s\S]*260824-360773138722084[\s\S]*dd4e83ee-7bea-4986-9fc3-fda2545b2918[\s\S]*500013045196272/u,
  'migration 245 must target only the second exact evidence receipt canary');
assert.match(pddEvidenceReceiptConfirmationCanaryMigration,
  /submitAttemptCount\}', '0'\) = '0'[\s\S]*lastClickAttemptedAt\}' IS NULL[\s\S]*effect\.status IN \('reserved', 'unknown'\)[\s\S]*effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status = 'succeeded'/u,
  'migration 245 must prove no submit click and exclude unresolved or successful submit effects');
assert.match(pddEvidenceReceiptConfirmationCanaryMigration,
  /pdd_mms-network-receipt-and-form-confirmation[\s\S]*245_canary_pdd_evidence_receipt_confirmation\.sql/u,
  'migration 245 must retain the exact receipt confirmation strategy and schema version');
assert.match(pddEvidence48143FirstBatchMigration,
  /CROSS JOIN LATERAL[\s\S]*LIMIT 2[\s\S]*FOR UPDATE OF work_order, instance SKIP LOCKED/u,
  'migration 246 must release no more than two locked rows per shop');
assert.match(pddEvidence48143FirstBatchMigration,
  /binding\.actual_shop_name = shop\.expected_shop_name[\s\S]*instance\.identity_status = 'verified'[\s\S]*authorizationFailure,errorCode\}' =\s*'48143'/u,
  'migration 246 must prove current shop identity and the exact retired-bucket failure');
assert.match(pddEvidence48143FirstBatchMigration,
  /lastClickAttemptedAt\}' IS NULL[\s\S]*receipt IS NULL[\s\S]*effect\.status IN \('reserved', 'unknown'\)[\s\S]*effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status = 'succeeded'/u,
  'migration 246 must reject clicked, receipted, unresolved, and completed PDD submits');
assert.match(pddEvidence48143FirstBatchMigration,
  /tms-recall-evidence[\s\S]*tms-reminder-evidence[\s\S]*tms-delivery-contact-evidence[\s\S]*tmsEvidenceScreenshot,relativePath\}' =[\s\S]*effect\.effect_type = 'tms-create'[\s\S]*effect\.effect_type = 'pdd-note'/u,
  'migration 246 must retain a bound TMS image and committed prerequisite effects');
assert.match(pddEvidence48143FirstBatchMigration,
  /omsWarehouseParse,status\}' = 'confirmed'[\s\S]*简卓\|众邦\|铭如\|瞳琪\|捷佑\|亿哈\|筑越仓\|迅发\|品动工贸\|祺迦工贸/u,
  'migration 246 must retain the explicit OMS warehouse allow-list');
assert.doesNotMatch(pddEvidence48143FirstBatchMigration,
  /久伴体育|(?:UPDATE|DELETE FROM)\s+external_effects/u,
  'migration 246 must not admit a forbidden warehouse or rewrite effect history');
assert.match(pddEvidence48143FirstBatchMigration,
  /externalActionsReplayedByMigration', false[\s\S]*246_recover_pdd_evidence_48143_first_batch\.sql/u,
  'migration 246 must audit that it replays no external action itself');
assert.match(pddEvidence48143RemainingSafeMigration,
  /CROSS JOIN LATERAL[\s\S]*LIMIT 1000[\s\S]*FOR UPDATE OF work_order, instance SKIP LOCKED/u,
  'migration 247 must lock every remaining eligible row under a defensive per-shop ceiling');
assert.match(pddEvidence48143RemainingSafeMigration,
  /lastClickAttemptedAt\}' IS NULL[\s\S]*receipt IS NULL[\s\S]*effect\.status IN \('reserved', 'unknown'\)[\s\S]*effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status = 'succeeded'/u,
  'migration 247 must preserve the canary submit and external-effect safety gates');
assert.match(pddEvidence48143RemainingSafeMigration,
  /tmsEvidenceScreenshot,relativePath\}' =[\s\S]*omsWarehouseParse,status\}' = 'confirmed'[\s\S]*effect\.effect_type = 'tms-create'[\s\S]*effect\.effect_type = 'pdd-note'/u,
  'migration 247 must preserve warehouse, local evidence, and prerequisite effect proofs');
assert.doesNotMatch(pddEvidence48143RemainingSafeMigration,
  /久伴体育|(?:UPDATE|DELETE FROM)\s+external_effects/u,
  'migration 247 must not admit a forbidden warehouse or rewrite effect history');
assert.match(pddEvidence48143RemainingSafeMigration,
  /remaining-safe[\s\S]*externalActionsReplayedByMigration', false[\s\S]*247_recover_pdd_evidence_48143_remaining_safe\.sql/u,
  'migration 247 must audit its remaining-safe batch without replaying an action itself');
assert.match(stalePddEvidence48143RecaptureCanaryMigration,
  /CROSS JOIN LATERAL[\s\S]*LIMIT 1[\s\S]*FOR UPDATE OF work_order, instance SKIP LOCKED/u,
  'migration 256 must release at most one stale-evidence canary per enabled shop');
assert.match(stalePddEvidence48143RecaptureCanaryMigration,
  /lastClickAttemptedAt\}' IS NULL[\s\S]*submitAttemptCount[\s\S]*::int <= 1[\s\S]*effect\.status IN \('reserved', 'unknown'\)[\s\S]*effect\.status = 'succeeded'[\s\S]*clickAttempted/u,
  'migration 256 must exclude clicked, unresolved, and successful PDD effects');
assert.match(stalePddEvidence48143RecaptureCanaryMigration,
  /scenario_code = 'delivery-risk-concern'[\s\S]*commonFlowTicket,status[\s\S]*omsTmsFlowCompleted[\s\S]*tms-recall-evidence[\s\S]*tmsRecallCompleted/u,
  'migration 256 must accept each scenario only after its matching TMS stage is durable');
assert.match(stalePddEvidence48143RecaptureCanaryMigration,
  /1 >= \([\s\S]*effect_type = 'pdd-submit'[\s\S]*NOT EXISTS \([\s\S]*effect_type = 'pdd-submit'[\s\S]*status = 'failed'[\s\S]*48143[\s\S]*receipt IS NULL/u,
  'migration 256 may accept no submit effect, but any retained submit effect must be an unclicked 48143 failure');
assert.match(stalePddEvidence48143RecaptureCanaryMigration,
  /tmsWorkOrder,status\}' = 'created'[\s\S]*tms-create'[\s\S]*ticketId[\s\S]*ticketNo[\s\S]*- 'tmsEvidenceScreenshot'[\s\S]*- 'tmsEvidenceDisposition'/u,
  'migration 256 must preserve the committed TMS ticket while forcing local evidence recapture');
assert.match(stalePddEvidence48143RecaptureCanaryMigration,
  /binding\.actual_shop_name = shop\.expected_shop_name[\s\S]*pddIdentityBindingToken'[\s\S]*identityReboundAt/u,
  'migration 256 must rebind only the current verified PDD shop identity');
assert.match(stalePddEvidence48143RecaptureCanaryMigration,
  /tms-recall-evidence[\s\S]*tms-reminder-evidence[\s\S]*tms-delivery-contact-evidence[\s\S]*pdd-shipping-logistics-screenshot/u,
  'migration 256 must explicitly cover every supported stale evidence source');
assert.doesNotMatch(stalePddEvidence48143RecaptureCanaryMigration,
  /久伴体育|(?:UPDATE|DELETE FROM)\s+external_effects/iu,
  'migration 256 must not admit a forbidden warehouse or rewrite effect history');
assert.match(stalePddEvidence48143RecaptureCanaryMigration,
  /rebind-recapture-and-upload-with-pdd_mms-fallback[\s\S]*externalActionsReplayedByMigration', false[\s\S]*256_canary_recapture_stale_pdd_evidence_48143\.sql/u,
  'migration 256 must audit recapture without replaying an external action itself');
assert.match(remainingStalePddEvidence48143RecoveryMigration,
  /FOR UPDATE OF work_order, instance SKIP LOCKED[\s\S]*remaining-stale-pdd-evidence-48143-recapture-retry-ready/u,
  'migration 257 must lock and release every remaining safe stale-evidence row');
assert.match(remainingStalePddEvidence48143RecoveryMigration,
  /lastClickAttemptedAt\}' IS NULL[\s\S]*submitAttemptCount[\s\S]*::int <= 1[\s\S]*effect\.status IN \('reserved', 'unknown'\)[\s\S]*effect\.status = 'succeeded'[\s\S]*clickAttempted/u,
  'migration 257 must exclude clicked, unresolved, and successful PDD effects');
assert.match(remainingStalePddEvidence48143RecoveryMigration,
  /tmsWorkOrder,status\}' = 'created'[\s\S]*tms-create'[\s\S]*ticketId[\s\S]*ticketNo[\s\S]*- 'tmsEvidenceScreenshot'[\s\S]*- 'tmsEvidenceDisposition'/u,
  'migration 257 must preserve the durable TMS ticket while forcing fresh evidence capture');
assert.match(remainingStalePddEvidence48143RecoveryMigration,
  /binding\.actual_shop_name = shop\.expected_shop_name[\s\S]*pddIdentityBindingToken'[\s\S]*identityReboundAt/u,
  'migration 257 must bind each retry to the current verified PDD identity');
assert.doesNotMatch(remainingStalePddEvidence48143RecoveryMigration,
  /久伴体育|(?:UPDATE|DELETE FROM)\s+external_effects/iu,
  'migration 257 must not admit a forbidden warehouse or rewrite effect history');
assert.match(remainingStalePddEvidence48143RecoveryMigration,
  /rebind-recapture-and-upload-with-pdd_mms-fallback[\s\S]*externalActionsReplayedByMigration', false[\s\S]*257_recover_remaining_stale_pdd_evidence_48143\.sql/u,
  'migration 257 must audit recapture without replaying an external action itself');
assert.match(clickedOrSucceededPddEvidence48143ReconciliationMigration,
  /effect\.status = 'succeeded'[\s\S]*clickAttempted/u,
  'migration 258 must require a click receipt for a successful submit effect');
assert.match(clickedOrSucceededPddEvidence48143ReconciliationMigration,
  /effect\.status = 'failed'[\s\S]*48143[\s\S]*lastClickAttemptedAt\}'[\s\S]*IS NOT NULL/u,
  'migration 258 must pair a failed 48143 effect with a persisted click attempt');
assert.match(clickedOrSucceededPddEvidence48143ReconciliationMigration,
  /effect\.status IN \('reserved', 'unknown'\)[\s\S]*external-state-reconciliation-ready[\s\S]*maximumAutomaticSubmitAttempts', 1/u,
  'migration 258 must exclude unresolved effects and schedule a no-resubmit reconciliation target');
assert.match(clickedOrSucceededPddEvidence48143ReconciliationMigration,
  /externalStateReconciliationTarget'[\s\S]*effectType', 'pdd-submit'[\s\S]*externalStateReconciliationRetry'[\s\S]*maxAttempts', 3/u,
  'migration 258 must persist the exact PDD submit target and bounded read-only retry budget');
assert.doesNotMatch(clickedOrSucceededPddEvidence48143ReconciliationMigration,
  /(?:UPDATE|DELETE FROM)\s+external_effects/iu,
  'migration 258 must preserve external-effect history');
assert.match(clickedOrSucceededPddEvidence48143ReconciliationMigration,
  /observe-exact-pdd-state-without-resubmit[\s\S]*externalActionsReplayedByMigration', false[\s\S]*258_reconcile_clicked_or_succeeded_pdd_evidence_48143\.sql/u,
  'migration 258 must audit that it schedules read-only observation without replaying a business action');
assert.match(manualPddEvidence48143RecoveryMigration,
  /260814-449105108553594[\s\S]*260814-539177859383497[\s\S]*260801-633088253550254[\s\S]*260817-460733878633825/u,
  'migration 259 must target only the four audited unclicked manual evidence failures');
assert.match(manualPddEvidence48143RecoveryMigration,
  /lastClickAttemptedAt\}' IS NULL[\s\S]*effect\.status IN \('reserved', 'unknown'\)[\s\S]*effect\.effect_type = 'pdd-submit'[\s\S]*clickAttempted/u,
  'migration 259 must reject unresolved or clicked PDD effects');
assert.match(manualPddEvidence48143RecoveryMigration,
  /tmsWorkOrder,status\}' = 'created'[\s\S]*tms-create'[\s\S]*ticketId[\s\S]*ticketNo/u,
  'migration 259 must require the committed TMS ticket');
assert.match(manualPddEvidence48143RecoveryMigration,
  /omsAnalysis,shippingWarehouse\}' !~ '久伴体育'/u,
  'migration 259 must exclude the forbidden warehouse');
assert.doesNotMatch(manualPddEvidence48143RecoveryMigration,
  /(?:UPDATE|DELETE FROM)\s+external_effects/iu,
  'migration 259 must preserve external-effect history');
assert.match(manualPddEvidence48143RecoveryMigration,
  /rebind-recapture-and-upload-with-pdd_mms-fallback[\s\S]*externalActionsReplayedByMigration', false[\s\S]*259_recover_unclicked_manual_pdd_evidence_48143\.sql/u,
  'migration 259 must only queue exact recapture and audit that no business action was replayed');
assert.match(remainingClickedPddSubmissionReconciliationMigration,
  /260821-589824080293627[\s\S]*260823-257205256602307/u,
  'migration 260 must target only the two audited clicked submissions');
assert.match(remainingClickedPddSubmissionReconciliationMigration,
  /effect\.status IN \('succeeded', 'unknown'\)[\s\S]*clickAttempted/u,
  'migration 260 must require a successful, unknown, or explicitly clicked PDD submit effect');
assert.match(remainingClickedPddSubmissionReconciliationMigration,
  /external-state-reconciliation-ready[\s\S]*externalStateReconciliationTarget'[\s\S]*effectType', 'pdd-submit'[\s\S]*maxAttempts', 3/u,
  'migration 260 must schedule bounded exact PDD submit reconciliation');
assert.doesNotMatch(remainingClickedPddSubmissionReconciliationMigration,
  /(?:UPDATE|DELETE FROM)\s+external_effects/iu,
  'migration 260 must preserve external-effect history');
assert.match(remainingClickedPddSubmissionReconciliationMigration,
  /observe-exact-pdd-state-without-resubmit[\s\S]*externalActionsReplayedByMigration', false[\s\S]*260_reconcile_remaining_clicked_pdd_submissions\.sql/u,
  'migration 260 must audit that it schedules read-only observation without replaying a business action');
assert.match(postSubmitReferenceErrorArchiveMigration,
  /331818da-a136-4cc1-9cee-bc21f4b9648a[\s\S]*shop-mse1sff3-b85aa4[\s\S]*260822-622959061370182[\s\S]*0b4ec484-048a-49f7-9e06-58d45af41038[\s\S]*500013044567047[\s\S]*告知送达地址并承诺核实/u,
  'migration 241 must target only the exact inspected work order and verified PDD instance');
assert.match(postSubmitReferenceErrorArchiveMigration,
  /binding\.actual_shop_name = shop\.expected_shop_name[\s\S]*binding\.binding_token::text[\s\S]*binding\.mall_id/,
  'migration 241 must require the current exact shop identity binding');
assert.match(postSubmitReferenceErrorArchiveMigration,
  /manual_review_reason = 'retryAuthorized is not defined'[\s\S]*payload->>'error' = 'retryAuthorized is not defined'[\s\S]*pddResolutionSubmission,status\}' = 'submitting'/,
  'migration 241 must require the exact post-submit ReferenceError state');
assert.match(postSubmitReferenceErrorArchiveMigration,
  /submit_effect\.status = 'succeeded'[\s\S]*selectedPddOutcome\}' =[\s\S]*expected\.selected_outcome[\s\S]*selectedPddOption\}' =[\s\S]*expected\.selected_outcome[\s\S]*submitClicked\}' = 'true'[\s\S]*submitReceipt,success\}' = 'true'[\s\S]*transitionConfirmed\}' = 'true'/u,
  'migration 241 must prove the exact selected outcome and successful PDD transition receipt');
assert.match(postSubmitReferenceErrorArchiveMigration,
  /effect_type = 'tms-create'[\s\S]*effect\.status = 'succeeded'[\s\S]*effect_type = 'pdd-note'[\s\S]*effect\.status = 'succeeded'[\s\S]*count\(\*\)[\s\S]*effect_type = 'pdd-submit'[\s\S]*effect\.status = 'succeeded'/,
  'migration 241 must prove TMS, note, and exactly one PDD submit succeeded');
assert.match(postSubmitReferenceErrorArchiveMigration,
  /effect\.status IN \('reserved', 'unknown'\)[\s\S]*lease_expires_at > now\(\)/,
  'migration 241 must reject unresolved effects and an active lease');
assert.match(postSubmitReferenceErrorArchiveMigration,
  /SET status = 'archived'[\s\S]*current_step = 'requested-order-complete'[\s\S]*completion_state = 'confirmed'[\s\S]*completion_confirmation_method = 'pdd-submit-success-receipt'[\s\S]*lastCompletedOrder[\s\S]*businessEffectsReplayed', false/,
  'migration 241 must archive confirmed completion without replaying a business effect');
assert.match(postSubmitReferenceErrorArchiveMigration,
  /reason_code = 'external-system-error'[\s\S]*241_archive_post_submit_reference_error\.sql/,
  'migration 241 must resolve only the related technical intervention and record its version');
assert.doesNotMatch(postSubmitReferenceErrorArchiveMigration,
  /(?:UPDATE|DELETE FROM)\s+external_effects/iu,
  'migration 241 must preserve every durable external-effect receipt');
assert.match(confirmedDirectSubmitOutcomeTextMismatchArchiveMigration,
  /90e2c59e-2fb9-4639-8065-1ddfacbe8ae3[\s\S]*songteng-yazc-overseas[\s\S]*260822-677967378830137[\s\S]*0361652d-48dd-401a-87f5-7768072ab025[\s\S]*500013046624206/u,
  'migration 250 must target only the exact inspected work order and verified PDD instance');
assert.match(confirmedDirectSubmitOutcomeTextMismatchArchiveMigration,
  /instance\.identity_status = 'verified'[\s\S]*binding\.actual_shop_name = shop\.expected_shop_name[\s\S]*binding\.binding_token::text/,
  'migration 250 must require current shop binding and verified instance identity');
assert.match(confirmedDirectSubmitOutcomeTextMismatchArchiveMigration,
  /selectedPddOutcome\}' = expected\.selected_outcome[\s\S]*selectedPddOption\}' = expected\.selected_outcome[\s\S]*submitClicked\}' = 'true'[\s\S]*submitReceipt,success\}' = 'true'[\s\S]*transitionConfirmed\}' = 'true'/u,
  'migration 250 must prove the selected option, successful receipt, and page transition');
assert.match(confirmedDirectSubmitOutcomeTextMismatchArchiveMigration,
  /completion_state = 'confirmed'[\s\S]*completion-outcome-mismatch[\s\S]*pddResolutionSubmission,completionEvidence\}' =[\s\S]*expected\.completed_page_text/,
  'migration 250 must require the exact already-confirmed outcome-text mismatch');
assert.match(confirmedDirectSubmitOutcomeTextMismatchArchiveMigration,
  /effect_type = 'tms-create'[\s\S]*effect_type = 'pdd-note'[\s\S]*effect_type = 'evidence-upload'[\s\S]*count\(\*\)[\s\S]*effect_type = 'pdd-submit'/,
  'migration 250 must prove every prerequisite effect and exactly one successful submit');
assert.match(confirmedDirectSubmitOutcomeTextMismatchArchiveMigration,
  /effect\.status IN \('reserved', 'unknown'\)[\s\S]*lease_expires_at > now\(\)[\s\S]*businessEffectsReplayed', false/,
  'migration 250 must reject unresolved effects or an active lease and replay nothing');
assert.match(confirmedDirectSubmitOutcomeTextMismatchArchiveMigration,
  /SET status = 'archived'[\s\S]*current_step = 'requested-order-complete'[\s\S]*direct-submit-success-and-transition[\s\S]*250_archive_confirmed_direct_submit_outcome_text_mismatch\.sql/,
  'migration 250 must archive only local state and record its schema version');
assert.doesNotMatch(confirmedDirectSubmitOutcomeTextMismatchArchiveMigration,
  /(?:UPDATE|DELETE FROM)\s+external_effects/iu,
  'migration 250 must preserve all durable external-effect receipts');
assert.match(proactiveIframeSubmitReconciliationRetryMigration,
  /260810-655664167331689[\s\S]*260814-043421570680710[\s\S]*260817-295866274161800/,
  'migration 242 must target only the three inspected frame-submit reconciliations');
assert.match(proactiveIframeSubmitReconciliationRetryMigration,
  /instance\.platform_case_id = expected\.platform_case_id[\s\S]*instance\.identity_status = 'verified'[\s\S]*binding\.actual_shop_name = shop\.expected_shop_name/,
  'migration 242 must prove exact instance and current shop identity');
assert.match(proactiveIframeSubmitReconciliationRetryMigration,
  /unknown_effect\.status = 'unknown'[\s\S]*clickAttempted' = 'true'[\s\S]*responseCaptured' = 'false'/,
  'migration 242 must preserve an actually clicked but unconfirmed final submit');
assert.match(proactiveIframeSubmitReconciliationRetryMigration,
  /submitAttemptCount}' = '3'[\s\S]*ordinaryPddFrameSubmitRecovery239,status}' =\s*'retry-authorized'[\s\S]*1 = \([\s\S]*effect\.status = 'unknown'/,
  'migration 242 must bind the exhausted one-time frame retry and its only unknown effect');
assert.match(proactiveIframeSubmitReconciliationRetryMigration,
  /recovery_state = 'ready'[\s\S]*submitted-unconfirmed[\s\S]*externalStateReconciliationTarget[\s\S]*observe-pdd-state-without-resubmit[\s\S]*businessEffectsReplayed', false/,
  'migration 242 may schedule only read-only reconciliation without another submit');
assert.match(proactiveIframeSubmitReconciliationRetryMigration,
  /effect\.status = 'reserved'[\s\S]*lease_expires_at > now\(\)/,
  'migration 242 must reject reserved effects and active leases');
assert.doesNotMatch(proactiveIframeSubmitReconciliationRetryMigration,
  /(?:UPDATE|DELETE FROM)\s+external_effects/iu,
  'migration 242 must preserve the unknown PDD effect for read-only proof');
assert.match(workflow,
  /submitClickNotAttempted[\s\S]*status: 'render-retry'/);
assert.match(workflow,
  /ordinary-submit-render-recovery-waiting[\s\S]*maxAttempts: 2[\s\S]*recover-ordinary-submit-render/);
assert.match(workflow, /open-ordinary-pdd-decision-form/);
assert.match(workflow, /submitAttemptCount: previousSubmitAttemptCount \+ 1/);
assert.match(ordinaryDecisionFormRecoveryMigration,
  /ordinary-decision-form-pause-recovered/);
assert.match(ordinaryDecisionFormRecoveryMigration,
  /open-unique-decision-entry-before-option-wait/);
assert.match(workflow,
  /OMS_MANUAL_ALLOCATION_RENDER_TIMEOUT_MS \|\| 30_000/);
assert.match(workflow,
  /oms-manual-allocation-render-reloading/);
assert.match(workflow,
  /targetPage\.reload\(\{ waitUntil: 'domcontentloaded', timeout: 60_000 \}\)/);
assert.match(omsManualAllocationRenderRecoveryMigration,
  /oms-manual-allocation-render-pause-recovered/);
assert.match(omsManualAllocationRenderRecoveryMigration,
  /wait-30-seconds-then-refresh-once/);
assert.match(omsManualAllocationRenderRecoveryMigration,
  /effect\.effect_type = 'oms-manual-allocation'/);
assert.match(omsManualAllocationRenderRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(unconfirmedOrdinarySubmitRecoveryMigration,
  /ordinary-submit-confirmation-pause-recovered/);
assert.match(unconfirmedOrdinarySubmitRecoveryMigration,
  /maximumAutomaticSubmitAttempts', 2/);
assert.match(singleSubmitNoRetryMigration,
  /single-submit-read-only-reconciliation-recovered/);
assert.match(singleSubmitNoRetryMigration,
  /effect\.id = 'ad6fd346-c917-4397-bf4b-263c86da6191'::uuid/);
assert.match(singleSubmitNoRetryMigration,
  /maximumAutomaticSubmitAttempts', 1/);
assert.match(singleSubmitNoRetryMigration,
  /count\(\*\)[\s\S]*effect_type = 'pdd-submit'[\s\S]*\) = 1/);
assert.match(singleSubmitNoRetryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(runner,
  /recoverProactiveLogisticsPostResultFollowups\(\{ shopId \}\)[\s\S]{0,420}ordinary-post-result-followup-auto-recovered/,
  'the resident worker must release eligible proactive-logistics follow-up pauses before claiming new work');
assert.match(postgresAdapter,
  /async recoverProactiveLogisticsPostResultFollowups[\s\S]*instance\.scenario_code = 'proactive-logistics-service'[\s\S]*consumer-return-waybill-confirmation-required[\s\S]*result_effect\.idempotency_key LIKE '%:result'[\s\S]*ordinary-post-result-followup-retry-ready/,
  'post-result recovery must require a succeeded terminal result and resume only the separately guarded follow-up');
assert.match(postgresAdapter,
  /followup_effect\.idempotency_key LIKE '%-send-script-v1'[\s\S]*followup_effect\.idempotency_key LIKE '%-submit-prefilled-reply-v1'[\s\S]*followup_effect\.status IN \('succeeded', 'reserved', 'unknown'\)/,
  'post-result recovery must not duplicate an already committed or unresolved consumer-message action');
assert.match(postgresAdapter,
  /pddResolutionSubmission,effectStage[\s\S]{0,600}:result[\s\S]{0,900}completed_followup_effect/,
  'post-result recovery must not consume a separately completed third-stage radio submission');
assert.match(exhaustedSubmitManualMigration,
  /exhausted-submit-reconciliation-marked-manual/);
assert.match(exhaustedSubmitManualMigration,
  /pdd-submit-reconciliation-exhausted/);
assert.match(exhaustedSubmitManualMigration,
  /manual-review-no-resubmit/);
assert.match(exhaustedSubmitManualMigration,
  /externalStateReconciliation,automaticRetryExhausted.*= 'true'/s);
assert.match(interruptedPddNoteReconciliationMigration,
  /interrupted-pdd-note-reconciliation-recovered/);
assert.match(interruptedPddNoteReconciliationMigration,
  /resume-read-only-reconciliation-after-worker-reload/);
assert.match(interruptedPddNoteReconciliationMigration,
  /effect\.status = 'unknown'/);
assert.match(interruptedPddNoteReconciliationMigration,
  /NOT EXISTS \([\s\S]*submit_effect\.effect_type = 'pdd-submit'/);
assert.match(interruptedPddNoteReconciliationMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(interruptedPddNoteReconciliationMigration,
  /externalStateReconciliationRetry,attempts}' IN \('2', '3'\)/);
assert.match(interruptedPddNoteReconciliationMigration,
  /interruptedAttemptRefundedAt/);
assert.match(pddNoteListRedirectRecoveryMigration,
  /pdd-note-list-redirect-reconciliation-recovered/);
assert.match(pddNoteListRedirectRecoveryMigration,
  /refresh-then-exact-pending-list-query/);
assert.match(pddNoteListRedirectRecoveryMigration,
  /effect\.effect_type = 'pdd-note'[\s\S]*effect\.status = 'unknown'/);
assert.match(pddNoteListRedirectRecoveryMigration,
  /NOT EXISTS \([\s\S]*submit_effect\.effect_type = 'pdd-submit'/);
assert.match(pddNoteListRedirectRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(pddNoteListRedirectRecoveryMigration,
  /binding\.status = 'confirmed'[\s\S]*binding\.expected_shop_name = shop\.expected_shop_name/);
assert.match(rollingReloadPddNoteRecoveryMigration,
  /rolling-reload-pdd-note-reconciliation-recovered/);
assert.match(rollingReloadPddNoteRecoveryMigration,
  /resume-list-redirect-reconciliation-after-rolling-reload/);
assert.match(rollingReloadPddNoteRecoveryMigration,
  /work_order\.recovery_state = 'reconciling'/);
assert.match(rollingReloadPddNoteRecoveryMigration,
  /effect\.effect_type = 'pdd-note'[\s\S]*effect\.status = 'unknown'/);
assert.match(rollingReloadPddNoteRecoveryMigration,
  /NOT EXISTS \([\s\S]*submit_effect\.effect_type = 'pdd-submit'/);
assert.match(rollingReloadPddNoteRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(runner,
  /let checkpointedProgressAt = readProgress\(\)\.updatedAt \|\| null/);
assert.match(runner,
  /residentTerminalFailure[\s\S]*reconciliation-terminal-progress/);
assert.match(runner,
  /typeof progress\.error === 'string'[\s\S]*progress\.error\?\.message/);
assert.match(workflow,
  /pdd-note-reconciliation-refreshing[\s\S]*refresh-pdd-note-reconciliation/);
assert.match(workflow,
  /remarkPage\.url\(\)\.includes\('\/aftersales\/work_order\/list'\)[\s\S]*submitPendingOrderQuery\(remarkPage, orderNumber, 'note-reconciliation'\)/);
assert.match(workflow,
  /confirmEmptyAfterRefresh: true[\s\S]*refreshed-exact-pending-list-absence/);
assert.match(workflow,
  /identity\.status === 'detected'[\s\S]*!isMaskedPddShopIdentityName\(actualShopName\)/);
assert.match(workflow,
  /timeoutMs: pddRenderWaitMs[\s\S]*pdd-order-remark-reconciliation/);
assert.match(postgresAdapter, /pdd_submit_reconciliation_target/);
assert.match(postgresAdapter, /AND id = \$7::uuid/);
assert.match(postgresAdapter, /已达到本工单自动提交上限，禁止重复提交，转人工核对/);
assert.match(postgresAdapter, /Boolean\(observation\?\.automaticRetryExhausted\)/);
assert.match(runner, /externalStateReconciliationTarget: reconciliationTarget/);
assert.match(terminalStaleReservationMigration,
  /terminal-stale-external-reservation-quarantined/);
assert.match(terminalStaleReservationMigration,
  /work_order\.completion_confirmed_at > effect\.reserved_at/);
assert.match(terminalStaleReservationMigration,
  /'unknown'/);
assert.match(extendedDetailShellRecoveryMigration, /extended-detail-shell-pause-recovered/);
assert.match(extendedDetailShellRecoveryMigration, /refresh-exact-pending-query-before-completion/);
assert.match(extendedDetailShellRecoveryMigration,
  /binding\.actual_shop_name = shop\.expected_shop_name/);
assert.match(extendedDetailShellRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(extendedDetailShellRecoveryMigration, /runtime\.lease_expires_at > now\(\)/);
assert.match(refreshedRequestedOrderAbsenceRecoveryMigration,
  /refreshed-requested-order-absence-pause-recovered/);
assert.match(refreshedRequestedOrderAbsenceRecoveryMigration,
  /ordinaryPendingListPresence,refreshed/);
assert.match(refreshedRequestedOrderAbsenceRecoveryMigration,
  /binding\.actual_shop_name = shop\.expected_shop_name/);
assert.match(refreshedRequestedOrderAbsenceRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(refreshedRequestedOrderAbsenceRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(windowsAbnormalExitRecoveryMigration,
  /Playwright workflow exited with code (?:4294967295|-1)/);
assert.match(windowsAbnormalExitRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(windowsAbnormalExitRecoveryMigration,
  /effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status IN \('succeeded', 'unknown'\)/);
assert.match(windowsAbnormalExitRecoveryMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(windowsAbnormalExitRecoveryMigration,
  /windows-abnormal-workflow-exit-recovered/);
assert.match(postgresAdapter, /return-refund-terminal-reconciliation-ready/);
assert.match(workflow, /pddResolutionSubmission: current\.pddResolutionSubmission/);
const pddResolutionWorkflow = workflow.slice(
  workflow.indexOf('const runPddResolutionWorkflow'),
  workflow.indexOf('const completedArchivePath'),
);
assert.ok(
  pddResolutionWorkflow.indexOf('if (pageState.isCompleted)')
    < pddResolutionWorkflow.indexOf('resolveReadyTmsEvidence(orderNumber, progress)'),
  'an exact completed PDD detail must be recovered before any TMS prerequisite can trigger work',
);
assert.match(pddResolutionWorkflow,
  /const consumerNegotiationResume = resolvePddConsumerNegotiationResume\(progress, orderNumber\);[\s\S]*if \(consumerNegotiationResume\)[\s\S]*decision = consumerNegotiationResume\.decision;[\s\S]*else \{[\s\S]*resolveReadyTmsEvidence\(orderNumber, progress\)/,
  'a confirmed consumer-negotiation follow-up must bypass replay of OMS/TMS prerequisites');
const ordinaryResumeRouting = workflow.slice(
  workflow.indexOf('const processOneWorkOrder'),
  workflow.indexOf('const initializeWorkflow'),
);
assert.ok(
  ordinaryResumeRouting.indexOf('resolvePddConsumerNegotiationResume(progress, progress.orderNumber)')
    < ordinaryResumeRouting.indexOf('resumeAllowed && tmsStageComplete'),
  'consumer-negotiation follow-up routing must run before generic TMS-stage recovery');
assert.match(workflow,
  /if \(decision\.flowCode !== 'consumer-negotiation-followup'\) \{\s*await ensurePddOrderRemark/,
  'consumer-negotiation follow-up must not repeat the already completed PDD remark effect');
assert.match(workflow,
  /const preparePddResolutionSubmissionPage[\s\S]{0,700}await ensurePddOrderRemark\(targetPage, decision\.orderNumber\)[\s\S]{0,300}return ensurePddResolutionSubmissionDetail\(targetPage, decision\.orderNumber\)/,
  'PDD resolution submission must revalidate the exact detail page after the optional remark flow');
assert.match(workflow,
  /const ensurePddResolutionSubmissionDetail[\s\S]{0,1800}reopenPddDetailForResolution\([\s\S]{0,250}\{ forcePendingList: true \}[\s\S]{0,500}hasConfirmedPendingListAbsence[\s\S]{0,400}PddWorkOrderAlreadyCompletedError/,
  'a stale or list-page resolution target must reopen the exact pending order without resubmitting completed work');
assert.match(workflow,
  /targetPage = await preparePddResolutionSubmissionPage\(targetPage, decision\);\s*const result = await submitPddResolution\(targetPage, decision, \{ prepared: true \}\)/,
  'resolution refresh recovery must retain the revalidated detail page for later retries');
assert.match(workflow,
  /while \(Date\.now\(\) < deadline\) \{\s*if \(!isPddDetailUrl\(targetPage\.url\(\)\)\) \{\s*throw new PddResolutionDetailContextLostError/,
  'submit-button waiting must stop immediately when PDD redirects away from the exact detail route');
assert.match(workflow,
  /for \(let contextRecoveryAttempt = 0; contextRecoveryAttempt < 2; contextRecoveryAttempt\+\+\)[\s\S]{0,1300}PddResolutionDetailContextLostError[\s\S]{0,900}ensurePddResolutionSubmissionDetail/,
  'a lost detail route must be reopened exactly once before resolution selection continues');
assert.match(workflow,
  /const findVisiblePddResolutionFormScope[\s\S]{0,1400}listVisibleOrdinaryPddOptions\(\[scope\]\)[\s\S]{0,900}anchorCount/,
  'resolution form discovery must support visible radio options before PDD renders a submit button');
assert.match(workflow,
  /await checkForHumanVerification\(targetPage, 'wait-resolution-form'\)[\s\S]{0,400}findVisiblePddResolutionFormScope[\s\S]{0,500}if \(!resolutionForm\) \{[\s\S]{0,500}waitForPddSubmitButton/,
  'PDD resolution must prefer option-first form discovery and retain submit-button fallback');
assert.match(workflow,
  /waitForPddSubmitButton\([\s\S]{0,180}allowDisabled: true[\s\S]{0,1800}submit\.locator/,
  'resolution form discovery must allow its submit button to remain disabled until an option is selected');
assert.match(workflow,
  /const enabled = await item\.isEnabled[\s\S]{0,140}if \(!enabled && !allowDisabled\) continue[\s\S]{0,5000}candidate\.enabled && candidate\.buttonText !== '确认'/,
  'disabled submit buttons may identify a radio form but must never be used as the unrelated fallback action');
assert.match(workflow,
  /clickPddSubmit\(targetPage, 'resolution', decision\.orderNumber, \{[\s\S]{0,160}guard: false,[\s\S]{0,160}selectedPddOption: expectedOutcome/,
  'the final PDD submit must remain bound to the selected refund outcome');
assert.match(workflow,
  /isDirectPddConsumerNegotiationFollowup[\s\S]{0,900}scenarioCode === 'in-transit-refund'[\s\S]{0,500}resume-pdd-followup-without-oms-or-tms-replay[\s\S]{0,500}submission\.orderNumber === exactOrder[\s\S]{0,500}followup-waiting[\s\S]{0,500}快递还在拦截中[\s\S]{0,500}consumerResponseWaitStartedAt[\s\S]{0,500}dispositionMayBeOmitted/u,
  'discarded TMS metadata may be omitted only for an exact direct-PDD consumer-negotiation resume');
assert.match(workflow,
  /markTmsEvidenceUnusedForPddResolution[\s\S]{0,500}isDirectPddConsumerNegotiationFollowup[\s\S]{0,700}omitted-after-consumer-negotiation-release[\s\S]{0,700}return markTmsEvidenceUnused\(orderNumber, workOrderType\)/,
  'the controlled disposition wrapper must retain strict evidence validation for every other flow');
assert.doesNotMatch(
  workflow.slice(workflow.indexOf('const submitPddResolution'), workflow.indexOf('const reopenPddDetailForResolution')),
  /\bmarkTmsEvidenceUnused\(decision\.orderNumber/,
  'PDD submission branches must pass evidence disposition through the controlled wrapper');
assert.match(pddResolutionWorkflow,
  /if \(currentDisposition && currentDisposition\.status !== 'deleted'\) \{\s*markTmsEvidenceUnused/,
  'the common follow-up finalizer must skip a deliberately absent TMS evidence disposition');
assert.match(consumerNegotiationDirectResumeMigration,
  /effect\.effect_type = 'tms-create'[\s\S]*effect\.status = 'succeeded'/);
assert.match(consumerNegotiationDirectResumeMigration,
  /effect\.effect_type = 'pdd-note'[\s\S]*effect\.status = 'succeeded'/);
assert.match(consumerNegotiationDirectResumeMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(consumerNegotiationDirectResumeMigration,
  /consumer-negotiation-followup-v1/);
assert.match(consumerNegotiationDirectResumeMigration,
  /binding\.actual_shop_name = shop\.expected_shop_name/);
assert.match(consumerNegotiationDirectResumeMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(runner,
  /recoverConsumerNegotiationFollowups\(\{ shopId \}\)[\s\S]{0,420}consumer-negotiation-followup-auto-recovered/,
  'the resident Worker must continuously recover consumer-negotiation waits missed by a one-time migration');
assert.match(postgresAdapter,
  /async recoverConsumerNegotiationFollowups[\s\S]*scenario_code = 'in-transit-refund'[\s\S]*consumer-negotiation-followup[\s\S]*tms_effect\.effect_type = 'tms-create'[\s\S]*tms_effect\.status = 'succeeded'[\s\S]*note_effect\.effect_type = 'pdd-note'[\s\S]*note_effect\.status = 'succeeded'/,
  'runtime follow-up recovery must require committed TMS and PDD remark effects');
assert.match(postgresAdapter,
  /async recoverConsumerNegotiationFollowups[\s\S]*unresolved_effect\.status IN \('reserved', 'unknown'\)[\s\S]*completed_followup_effect\.idempotency_key[\s\S]*consumer-negotiation-followup-v1[\s\S]*runtime\.lease_expires_at > now\(\)/,
  'runtime follow-up recovery must reject uncertain, completed, and actively leased work');
assert.match(postgresAdapter,
  /consumerNegotiationFollowupRecovery[\s\S]*resume-pdd-followup-without-oms-or-tms-replay[\s\S]*recoveryAttempts[\s\S]*maxRecoveryAttempts/,
  'runtime recovery must carry an attempt-bounded direct-PDD resume marker');
assert.match(consumerNegotiationRaceRecoveryMigration,
  /effect\.effect_type = 'tms-create'[\s\S]*effect\.status = 'succeeded'[\s\S]*effect\.effect_type = 'pdd-note'[\s\S]*effect\.status = 'succeeded'/);
assert.match(consumerNegotiationRaceRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)[\s\S]*consumer-negotiation-followup-v1[\s\S]*runtime\.lease_expires_at > now\(\)/);
assert.match(consumerNegotiationRaceRecoveryMigration,
  /consumerNegotiationFollowupRecovery[\s\S]*resume-pdd-followup-without-oms-or-tms-replay[\s\S]*recoveryAttempts/);
assert.match(workflow,
  /omsOrderStatusIsTerminalWithoutShipment[\s\S]*omsApiOrderStateIsTerminalWithoutShipment[\s\S]*oms-terminal-order-status/,
  'terminal OMS orders must bypass impossible manual allocation and produce an auditable PDD decision');
assert.match(workflow,
  /oms-manual-allocation-not-applicable-terminal-order/,
  'abnormal-network preparation must persist the terminal-order allocation bypass');
assert.match(terminalOmsManualAllocationRecoveryMigration,
  /binding\.actual_shop_name = shop\.expected_shop_name[\s\S]*effect\.effect_type = 'oms-manual-allocation'[\s\S]*runtime\.lease_expires_at > now\(\)/,
  'terminal OMS pause recovery must require current shop identity and exclude effects and live leases');
assert.match(terminalOmsManualAllocationRecoveryMigration,
  /terminal-oms-manual-allocation-pause-recovered[\s\S]*skip-impossible-manual-allocation-and-report-terminal-order/);
assert.match(terminalOmsManualAllocationRecoveryMigration,
  /210_recover_terminal_oms_manual_allocation_pauses\.sql/);
assert.match(resolvedVerificationBackoffRecoveryMigration,
  /current_step = 'human-verification-required'[\s\S]*verification\.status IN \('detected', 'waiting-human', 'verification-required'\)[\s\S]*effect\.status IN \('reserved', 'unknown'\)[\s\S]*runtime\.lease_expires_at > now\(\)/,
  'resolved verification recovery must exclude active challenges, uncertain effects, and live leases');
assert.match(resolvedVerificationBackoffRecoveryMigration,
  /verification-cleared-retry-ready[\s\S]*migration-resolved-verification-recovery[\s\S]*UPDATE ordinary_work_order_instances/);
assert.match(resolvedVerificationBackoffRecoveryMigration,
  /211_resume_resolved_verification_backoffs\.sql/);
assert.match(consumerNegotiationMissingEvidenceRecoveryMigration,
  /TMS 截图生命周期状态与当前订单不一致[\s\S]*consumer-negotiation-followup[\s\S]*effect\.effect_type = 'tms-create'[\s\S]*effect\.status = 'succeeded'/,
  'missing follow-up evidence recovery must require the exact defect and a committed TMS effect');
assert.match(consumerNegotiationMissingEvidenceRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)[\s\S]*consumer-negotiation-followup-v1[\s\S]*runtime\.lease_expires_at > now\(\)/,
  'missing follow-up evidence recovery must reject uncertain, completed, and actively leased work');
assert.match(consumerNegotiationMissingEvidenceRecoveryMigration,
  /212_recover_consumer_negotiation_missing_evidence_disposition\.sql/);
assert.match(consumerNegotiationPrimaryRefundEvidenceRecoveryMigration,
  /current_step = 'manual-review-blocked'[\s\S]*TMS 截图生命周期状态与当前订单不一致[\s\S]*flowCode' = 'primary-refund'/u,
  'migration 238 must target only the observed direct-refund evidence pause');
assert.match(consumerNegotiationPrimaryRefundEvidenceRecoveryMigration,
  /effect\.effect_type = 'tms-create'[\s\S]*effect\.status = 'succeeded'[\s\S]*effect\.effect_type = 'pdd-note'[\s\S]*effect\.status = 'succeeded'/,
  'migration 238 must prove the prior TMS create and PDD remark effects');
assert.match(consumerNegotiationPrimaryRefundEvidenceRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)[\s\S]*effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status = 'succeeded'[\s\S]*runtime\.lease_expires_at > now\(\)/,
  'migration 238 must reject uncertain effects, final PDD submits, and active leases');
assert.match(consumerNegotiationPrimaryRefundEvidenceRecoveryMigration,
  /binding\.actual_shop_name = shop\.expected_shop_name[\s\S]*flowCode', 'consumer-negotiation-followup'[\s\S]*238_recover_consumer_negotiation_primary_refund_evidence_pause\.sql/,
  'migration 238 must preserve exact shop identity and restore the follow-up flow');
assert.match(ordinaryDetailFreshQueryRecoveryMigration,
  /拼多多普通工单详情订单号渲染刷新后等待 \[0-9\]\+ 毫秒仍未出现有效结果[\s\S]*fresh-exact-order-query/,
  'stale rendered details must recover through an exact pending-order query');
assert.match(ordinaryDetailFreshQueryRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)[\s\S]*effect\.effect_type = 'pdd-submit'[\s\S]*runtime\.lease_expires_at > now\(\)/,
  'stale-detail recovery must reject uncertain, submitted, and actively leased work');
assert.match(ordinaryDetailFreshQueryRecoveryMigration,
  /213_recover_stale_ordinary_detail_render_loop\.sql/);
assert.match(runner,
  /OMS 补发页面\.\*快递责任补发[\s\S]*fastTransientFailure = \/OMS_QUERY_TEMPORARILY_UNAVAILABLE[\s\S]*OMS 补发\(\?:页面\|业务类型\)/,
  'OMS reissue render failures must use the fast bounded transient retry path');
assert.match(omsReissueRenderRecoveryMigration,
  /scenario_code = 'delivery-risk-concern'[\s\S]*effect\.effect_type = 'tms-create'[\s\S]*effect\.status = 'succeeded'/,
  'OMS reissue render recovery must require the exact scenario and committed TMS action');
assert.match(omsReissueRenderRecoveryMigration,
  /effect\.effect_type = 'oms-reissue-create'[\s\S]*effect\.status IN \('reserved', 'unknown', 'succeeded'\)[\s\S]*runtime\.lease_expires_at > now\(\)/,
  'OMS reissue render recovery must reject submitted or uncertain OMS effects and active leases');
assert.match(omsReissueRenderRecoveryMigration,
  /214_recover_oms_reissue_render_pauses\.sql/);
assert.match(omsReissueAdapter,
  /visibleComboboxes[\s\S]*visibleOptionTextElements[\s\S]*oms-reissue-reason-diagnostic/,
  'OMS reissue selection failures must expose bounded live DOM diagnostics');
assert.match(omsReissueDomDiagnosticRetryMigration,
  /scenario_code = 'delivery-risk-concern'[\s\S]*effect\.effect_type = 'tms-create'[\s\S]*effect\.status = 'succeeded'/,
  'diagnostic retry must require the exact scenario and committed TMS action');
assert.match(omsReissueDomDiagnosticRetryMigration,
  /effect\.effect_type = 'oms-reissue-create'[\s\S]*effect\.status IN \('reserved', 'unknown', 'succeeded'\)[\s\S]*runtime\.lease_expires_at > now\(\)/,
  'diagnostic retry must reject submitted or uncertain OMS effects and active leases');
assert.match(omsReissueDomDiagnosticRetryMigration,
  /215_retry_oms_reissue_with_dom_diagnostics\.sql/);
assert.match(omsReissueDoubleClickPickerRecoveryMigration,
  /scenario_code = 'delivery-risk-concern'[\s\S]*effect\.effect_type = 'tms-create'[\s\S]*effect\.status = 'succeeded'/,
  'double-click picker recovery must require the exact scenario and committed TMS action');
assert.match(omsReissueDoubleClickPickerRecoveryMigration,
  /effect\.effect_type = 'oms-reissue-create'[\s\S]*effect\.status IN \('reserved', 'unknown', 'succeeded'\)[\s\S]*runtime\.lease_expires_at > now\(\)/,
  'double-click picker recovery must reject submitted or uncertain OMS effects and active leases');
assert.match(omsReissueDoubleClickPickerRecoveryMigration,
  /278_recover_oms_reissue_double_click_picker\.sql/);
assert.match(omsFlatBatchReissueRecoveryMigration,
  /OMS 补发页面未找到按钮: 下一步[\s\S]*effect\.effect_type = 'tms-create'[\s\S]*effect\.status = 'succeeded'/,
  'flat batch retry must require the exact stale variant and committed TMS action');
assert.match(omsFlatBatchReissueRecoveryMigration,
  /effect\.effect_type = 'oms-reissue-create'[\s\S]*effect\.status IN \('reserved', 'unknown', 'succeeded'\)[\s\S]*runtime\.lease_expires_at > now\(\)/,
  'flat batch retry must reject submitted or uncertain OMS effects and active leases');
assert.match(omsFlatBatchReissueRecoveryMigration,
  /279_recover_oms_flat_batch_reissue_variant\.sql/);
assert.equal(
  postUpgradePddLoginPauseRecoveryMigration,
  overlayPostUpgradePddLoginPauseRecoveryMigration,
  'migration 288 must stay byte-identical in the root and deployment overlay',
);
assert.match(postUpgradePddLoginPauseRecoveryMigration,
  /08842946-3654-4bcf-b98d-26e7a59b05f6[\s\S]*songteng-yazc-overseas[\s\S]*260820-431300308550394[\s\S]*149b6e1f-a16d-43cc-972e-825056611b66[\s\S]*500013073650430[\s\S]*delivery-risk-concern/,
  'migration 288 must target only the inspected work order, instance, platform case, and scenario');
assert.match(postUpgradePddLoginPauseRecoveryMigration,
  /manual_review_reason = '拼多多登录后仍返回登录页'[\s\S]*instance\.identity_status = 'verified'[\s\S]*binding\.actual_shop_name = shop\.expected_shop_name[\s\S]*binding\.binding_token::text/,
  'migration 288 must require the exact old login pause and current verified shop identity');
assert.match(postUpgradePddLoginPauseRecoveryMigration,
  /ordinary-delivery-risk-lost-v1[\s\S]*ordinary-delivery-risk-reminder-v1[\s\S]*pdd-note[\s\S]*evidence-upload[\s\S]*status = 'succeeded'/,
  'migration 288 must require the already successful TMS, PDD note, and evidence effects');
assert.match(postUpgradePddLoginPauseRecoveryMigration,
  /platform-rejected-logistics-update-requires-reminder:primary'[\s\S]*submitReceipt,success\}' = 'true'[\s\S]*transitionConfirmed\}' = 'true'[\s\S]*需要联系物流核实[\s\S]*platform-reminder-result-requires-tms-confirmation:result'[\s\S]*submitReceipt,success\}' = 'true'[\s\S]*transitionConfirmed\}' = 'true'[\s\S]*物流可以更新，能送达/,
  'migration 288 must prove both successful PDD stage transitions and their exact outcomes');
assert.match(postUpgradePddLoginPauseRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)[\s\S]*effect\.idempotency_key NOT IN[\s\S]*runtime\.lease_expires_at > now\(\)/,
  'migration 288 must exclude unresolved effects, unexpected successful stages, and active leases');
assert.match(postUpgradePddLoginPauseRecoveryMigration,
  /pdd-login-reconciliation-retry-ready[\s\S]*pdd-detail-read-only-before-continuation[\s\S]*successfulPriorEffectsPreserved', true[\s\S]*externalActionsReplayedByMigration', false/,
  'migration 288 must resume at read-only PDD reconciliation without replaying successful effects');
assert.match(postUpgradePddLoginPauseRecoveryMigration,
  /resolved_by = coalesce\(intervention\.resolved_by, 'migration-288'\)[\s\S]*intervention\.reason_code = 'login-required'[\s\S]*288_recover_post_upgrade_pdd_login_pause\.sql/,
  'migration 288 must resolve only its login intervention and record the schema version');
assert.match(orphanedTmsCreateReconciliationMigration,
  /effect\.effect_type = 'tms-create'[\s\S]*effect\.status IN \('reserved', 'unknown'\)[\s\S]*runtime\.lease_expires_at > now\(\)/,
  'orphaned TMS creates must exclude active leases and remain read-only');
assert.match(orphanedTmsCreateReconciliationMigration,
  /external-state-reconciliation-ready[\s\S]*UPDATE ordinary_work_order_instances[\s\S]*read-only-tms-exact-order-query-no-blind-replay/);
assert.match(orphanedTmsCreateReconciliationMigration,
  /216_reconcile_orphaned_tms_create_effects\.sql/);
assert.match(reverseLogisticsSignedRefundMigration,
  /INSERT INTO scenario_definitions[\s\S]*reverse-logistics-signed-refund[\s\S]*逆向物流已签收[\s\S]*逆向物流签收催退款/,
  'migration 217 must register both stable title patterns for the new ordinary scenario');
assert.match(reverseLogisticsSignedRefundMigration,
  /UPDATE shops shop[\s\S]*reverse-logistics-signed-refund[\s\S]*ALTER COLUMN scenario_codes SET DEFAULT/,
  'migration 217 must enable the new scenario for existing and future shops');
assert.match(reverseLogisticsSignedRefundMigration,
  /217_add_reverse_logistics_signed_refund\.sql/);
assert.match(strictOmsWarehouseScopeMigration,
  /migration_218_out_of_scope_orders[\s\S]*代发聚水潭-[\s\S]*筑越\|简卓\|众邦\|铭如\|瞳琪\|捷佑\|亿哈/u,
  'migration 218 must quarantine only clearly readable warehouses outside the existing allow-list');
assert.match(strictOmsWarehouseScopeMigration,
  /current_step = 'oms-warehouse-out-of-scope'[\s\S]*recovery_state = 'held'[\s\S]*blockedOperations/u,
  'migration 218 must hard-stop current out-of-scope orders without retrying them');
assert.match(strictOmsWarehouseScopeMigration,
  /externalActionsReplayed', false[\s\S]*218_enforce_oms_warehouse_scope\.sql/u,
  'migration 218 must record that it replayed no external operation');
assert.match(expandedOmsWarehouseScopeMigration,
  /recovery_reason = 'oms-warehouse-out-of-scope-hard-stop'[\s\S]*代发聚水潭-迅发[\s\S]*代发聚水潭-品动工贸[\s\S]*代发聚水潭-祺迦工贸/u,
  'migration 219 must resume only orders held by the strict scope guard that match the expanded allow-list');
assert.doesNotMatch(expandedOmsWarehouseScopeMigration,
  /久伴体育/u,
  'migration 219 must not name or resume an unapproved warehouse');
assert.match(expandedOmsWarehouseScopeMigration,
  /existing_tms_work_order[\s\S]*existingTmsWorkOrderPreserved[\s\S]*externalActionsReplayed', false/u,
  'migration 219 must preserve existing TMS progress and never replay an external action itself');
assert.match(expandedOmsWarehouseScopeMigration,
  /reason_code = 'warehouse-out-of-scope'[\s\S]*219_expand_oms_warehouse_scope\.sql/u,
  'migration 219 must resolve only the superseded warehouse-scope intervention');
assert.match(abnormalNetworkWarehouseGuardRecoveryMigration,
  /scenario_code = 'abnormal-network-warning'[\s\S]*warehouseStatus[\s\S]*= 'not-applicable'[\s\S]*abnormalNetworkShipmentState[\s\S]*= 'unshipped'/u,
  'migration 224 must only recover the proven unshipped abnormal-network warehouse contradiction');
assert.match(abnormalNetworkWarehouseGuardRecoveryMigration,
  /effect_type IN \('oms-manual-allocation', 'tms-create', 'pdd-submit'\)[\s\S]*effect\.status IN \('reserved', 'unknown', 'succeeded'\)/u,
  'migration 224 must not replay a potentially applied OMS, TMS, or PDD action');
assert.match(abnormalNetworkWarehouseGuardRecoveryMigration,
  /- 'omsAnalysis'[\s\S]*re-read-warehouse-before-oms-allocation[\s\S]*externalActionsReplayed', false/u,
  'migration 224 must invalidate the stale not-applicable analysis before retrying');
assert.match(abnormalNetworkWarehouseGuardRecoveryMigration,
  /reason_code = 'external-system-error'[\s\S]*224_recover_abnormal_network_warehouse_guard\.sql/u,
  'migration 224 must resolve only the superseded transient warehouse intervention');
assert.match(pddOrderRemarkAdapter,
  /const selectRemarkColor = async[\s\S]*maxAttempts = 3[\s\S]*findRemarkColorOption[\s\S]*select-order-remark-color-retry-/u,
  'the PDD remark adapter must re-resolve and retry a color option lost during page re-rendering');
assert.match(workflow,
  /拼多多备注\.\*标记选择后未保持选中[\s\S]*pdd-order-remark-retry-ready/u,
  'a pre-save color selection race must remain automatically retryable');
assert.match(pddRemarkColorRerenderRecoveryMigration,
  /pddOrderRemark,reason[\s\S]*拼多多备注红色标记选择后未保持选中[\s\S]*effect_type IN \('pdd-note', 'pdd-submit'\)/u,
  'migration 225 must target only the exact pre-save color race and reject any PDD side effect');
assert.match(pddRemarkColorRerenderRecoveryMigration,
  /existingTmsEffectPreserved', true[\s\S]*externalActionsReplayed', false[\s\S]*reason_code = 'manual-review-required'/u,
  'migration 225 must preserve the successful TMS effect and resolve only its superseded manual review');
assert.match(workflow,
  /const selectOmsOrderRow = async[\s\S]*findRowCheckbox[\s\S]*ag-row-selected[\s\S]*attempt <= 3[\s\S]*OMS_ORDER_ROW_SELECTION_TEMPORARILY_UNAVAILABLE/u,
  'OMS row selection must reacquire a rerendered checkbox and become a bounded automatic retry');
assert.match(omsOrderRowSelectionRerenderRecoveryMigration,
  /OMS 目标订单行选择框勾选后未生效[\s\S]*effect_type IN \([\s\S]*'oms-manual-allocation', 'oms-reissue-create', 'pdd-note', 'pdd-submit'/u,
  'migration 226 must target only the exact OMS row selection failure and reject any OMS/PDD mutation');
assert.match(omsOrderRowSelectionRerenderRecoveryMigration,
  /existingTmsEffectPreserved', true[\s\S]*externalActionsReplayed', false[\s\S]*reason_code = 'oms-query-miss'/u,
  'migration 226 must preserve the successful TMS effect and resolve only the superseded OMS query intervention');
assert.match(workflow,
  /tmsCreateReconciliationSelectionPolicy[\s\S]*read-only-first-exact-order-user-authorized-pass-[\s\S]*selection\.count >= 1/u,
  'TMS create reconciliation must select the first exact duplicate row before identity verification');
assert.match(duplicateTmsFirstRowReconciliationMigration,
  /\{externalStateReconciliation,effectType\}' = 'tms-create'[\s\S]*effect\.effect_type = 'tms-create'[\s\S]*effect\.status IN \('reserved', 'unknown'\)[\s\S]*runtime\.lease_expires_at > now\(\)/u,
  'migration 227 must target only unresolved TMS creates and reject active leases');
assert.match(duplicateTmsFirstRowReconciliationMigration,
  /effect\.effect_type IN \([\s\S]*'oms-manual-allocation', 'oms-reissue-create', 'pdd-submit'[\s\S]*effect\.status IN \('reserved', 'unknown', 'succeeded'\)/u,
  'migration 227 must not resume an order after any OMS or PDD mutation');
assert.match(duplicateTmsFirstRowReconciliationMigration,
  /selectedIndex', 0[\s\S]*externalEffectPreserved', true[\s\S]*externalActionsReplayed', false[\s\S]*227_reconcile_duplicate_tms_rows_by_first_match\.sql/u,
  'migration 227 must preserve the unknown effect and prohibit duplicate external actions');
assert.match(consumerResponseWaitReclassificationMigration,
  /scenario_code = 'in-transit-refund'[\s\S]*current_step = 'logistics-waiting-released'[\s\S]*consumer-negotiation-followup[\s\S]*consumerResponseWaitStartedAt/u,
  'migration 228 must target only proven in-transit consumer negotiation waits');
assert.match(consumerResponseWaitReclassificationMigration,
  /current_step = 'consumer-response-waiting-released'[\s\S]*'waitKind', 'consumer-response'[\s\S]*'timerPreserved', true[\s\S]*'externalActionsReplayed', false/u,
  'migration 228 must relabel the wait without changing its timer or replaying actions');
assert.match(consumerResponseWaitReclassificationMigration,
  /NOT EXISTS \([\s\S]*shop_runtime_state[\s\S]*lease_expires_at > now\(\)[\s\S]*228_reclassify_consumer_response_waits\.sql/u,
  'migration 228 must leave actively leased work orders untouched');
assert.match(safePddDetailReloadAndRebindMigration,
  /instance\.identity_status = 'verified'[\s\S]*instance\.platform_case_key IS NOT NULL[\s\S]*binding\.mall_id = coalesce[\s\S]*binding_changed/u,
  'migration 220 must prove the current shop identity before rebinding a stale token');
assert.match(safePddDetailReloadAndRebindMigration,
  /page\[\.\]\(waitForURL\|goto\|reload\): Timeout \[0-9\]\+ms exceeded[\s\S]*instance\.detail_url[\s\S]*mms\[\.\]pinduoduo\[\.\]com\/aftersales\/work_order\/tododetail/u,
  'migration 220 must accept a verified instance detail URL for navigation recovery');
assert.match(safePddDetailReloadAndRebindMigration,
  /effect\.status IN \('reserved', 'unknown'\)[\s\S]*effect\.effect_type = 'pdd-submit'[\s\S]*effect\.status = 'succeeded'[\s\S]*runtime\.lease_expires_at > now\(\)/u,
  'migration 220 must preserve effect and live-lease safety guards');
assert.match(safePddDetailReloadAndRebindMigration,
  /transientWorkflowRecovery'[\s\S]*'count', 0[\s\S]*reason_code = 'external-system-error'[\s\S]*220_recover_safe_pdd_detail_reload_and_rebind\.sql/u,
  'migration 220 must reset the exhausted transient budget and resolve only related system errors');
assert.doesNotMatch(safePddDetailReloadAndRebindMigration, /warehouse-out-of-scope|久伴体育/u,
  'migration 220 must not alter explicit OMS warehouse scope decisions');
assert.match(pddAnchorUnavailableRecoveryMigration,
  /consumer-negotiation-followup-v1[\s\S]*responseCaptured[\s\S]*httpStatus[\s\S]*>= 400/u,
  'migration 237 must require a captured definitive HTTP rejection before authorizing recovery');
assert.match(pddAnchorUnavailableRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown', 'succeeded'\)[\s\S]*consumer-negotiation-followup-retry-v2[\s\S]*runtime\.lease_expires_at > now\(\)/u,
  'migration 237 must reject uncertain/applied effects, duplicate retry stages, and active leases');
assert.match(pddAnchorUnavailableRecoveryMigration,
  /unknownEffectsRetried', false[\s\S]*237_recover_pdd_anchor_unavailable\.sql/u,
  'migration 237 must audit that no unknown external effect was replayed');
assert.match(sparsePddDetailRecoveryMigration,
  /instance\.detail_url[\s\S]*拼多多\[\^\\r\\n\]\*刷新后等待[\s\S]*fresh-exact-order-query/u,
  'migration 221 must recover sparse detail URLs and arbitrary PDD render stage labels');
assert.match(sparsePddDetailRecoveryMigration,
  /effect\.status IN \('reserved', 'unknown'\)[\s\S]*effect\.effect_type = 'pdd-submit'[\s\S]*runtime\.lease_expires_at > now\(\)/u,
  'migration 221 must preserve effect and live-lease safety guards');
assert.doesNotMatch(sparsePddDetailRecoveryMigration, /warehouse-out-of-scope|久伴体育/u,
  'migration 221 must not alter explicit OMS warehouse scope decisions');
assert.match(runner,
  /recoverTerminalOmsManualAllocationPauses\(\{[\s\S]{0,220}identityBindingToken: currentPddIdentityBindingToken[\s\S]{0,420}terminal-oms-manual-allocation-auto-recovered/,
  'the resident Worker must continuously recover terminal OMS pauses missed by a one-time migration');
assert.match(postgresAdapter,
  /async recoverTerminalOmsManualAllocationPauses[\s\S]*binding\.actual_shop_name = shop\.expected_shop_name[\s\S]*binding\.binding_token = \$2::uuid[\s\S]*effect\.effect_type = 'oms-manual-allocation'[\s\S]*runtime\.lease_expires_at > now\(\)/,
  'runtime terminal OMS recovery must require current identity and exclude effects and live leases');
assert.match(postgresAdapter,
  /omsTerminalOrderRecovery[\s\S]*skip-impossible-manual-allocation-and-report-terminal-order[\s\S]*runtimeRecoveryAttempts[\s\S]*maxRuntimeRecoveryAttempts/,
  'runtime terminal OMS recovery must be attempt-bounded and preserve its terminal-order strategy');
assert.match(workflowRuntime,
  /canDiscardConsumerNegotiationFollowupEvidence[\s\S]*recoveredFromCompletedPage === true[\s\S]*confirmationMethod === 'detail-completed'[\s\S]*resume-pdd-followup-without-oms-or-tms-replay/,
  'consumer-negotiation evidence cleanup must require exact completed-detail and recovery proof');
assert.match(workflow,
  /discardConsumerNegotiationFollowupEvidence[\s\S]*isPathInside\(evidenceScreenshotDir, absolutePath\)[\s\S]*isPathInside\(tmsEvidenceScreenshotDir, absolutePath\)[\s\S]*path\.basename\(absolutePath\) !== `\$\{orderNumber\}\.png`/,
  'consumer-negotiation evidence cleanup must remain inside either controlled screenshot directory');
assert.match(consumerNegotiationCompletionFinalizeMigration,
  /recoveredFromCompletedPage' = 'true'/);
assert.match(consumerNegotiationCompletionFinalizeMigration,
  /confirmationMethod' = 'detail-completed'/);
assert.match(consumerNegotiationCompletionFinalizeMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(consumerNegotiationCompletionFinalizeMigration,
  /binding\.actual_shop_name = shop\.expected_shop_name/);
assert.match(consumerNegotiationCompletionFinalizeMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(consumerNegotiationCompletionFinalizeMigration,
  /completion_state, 'pending'\) IN \('pending', 'confirmed'\)/,
  'fresh deployments must recover confirmed consumer-negotiation completions');
assert.match(alreadyConfirmedConsumerNegotiationFinalizeMigration,
  /work_order\.completion_state = 'confirmed'/);
assert.match(alreadyConfirmedConsumerNegotiationFinalizeMigration,
  /recoveredFromCompletedPage' = 'true'/);
assert.match(alreadyConfirmedConsumerNegotiationFinalizeMigration,
  /confirmationMethod' = 'detail-completed'/);
assert.match(alreadyConfirmedConsumerNegotiationFinalizeMigration,
  /effect\.status IN \('reserved', 'unknown'\)/);
assert.match(alreadyConfirmedConsumerNegotiationFinalizeMigration,
  /binding\.actual_shop_name = shop\.expected_shop_name/);
assert.match(alreadyConfirmedConsumerNegotiationFinalizeMigration,
  /runtime\.lease_expires_at > now\(\)/);
assert.match(runner,
  /recoverSafeMisboundPddEvidencePauses\(\{[\s\S]{0,350}identityBindingToken: currentPddIdentityBindingToken[\s\S]{0,700}misbound-pdd-evidence-read-only-reconciliation-recovered/,
  'the resident Worker must recover an exactly matched cross-shop evidence pause after identity synchronization');
assert.match(postgresAdapter,
  /async recoverSafeMisboundPddEvidencePauses[\s\S]*scenario_code = 'in-transit-refund'[\s\S]*pddEvidenceUpload,status\}' = 'unknown'[\s\S]*file[.]pinduoduo[.]com[\s\S]*effect_type = 'evidence-upload'[\s\S]*effect\.status = 'unknown'/,
  'cross-shop evidence recovery must require the exact scenario, successful upload response, and only an unknown evidence effect');
assert.match(postgresAdapter,
  /pddResolutionSubmission,lastClickAttemptedAt\}' IS NULL[\s\S]*effect\.status = 'reserved'[\s\S]*effect\.effect_type = 'pdd-submit'[\s\S]*conflict\.status = 'open'/,
  'cross-shop evidence recovery must reject click attempts, reservations, PDD submits, and open conflicts');
assert.match(postgresAdapter,
  /pdd-detail-read-only-reconciliation-ready[\s\S]*crossShopPddEvidenceReadOnlyRecovery,status[\s\S]*binding\.binding_token::text[\s\S]*effect\.effect_type = 'evidence-upload'[\s\S]*effect\.effect_type <> 'evidence-upload'/,
  'the reconciliation claim must require the exact live identity and evidence-only recovery marker');
assert.match(postgresAdapter,
  /legacyPausedReadOnlyRelocationCandidates[\s\S]*identity_status = 'legacy-unverified'[\s\S]*detail_url_count = 1[\s\S]*profileFingerprint[\s\S]*pddResolutionSubmission,lastClickAttemptedAt[\s\S]*crossShopLegacyPddReadOnlyRecovery/,
  'legacy cross-shop pauses require a unique saved detail, exact page identity, and no prior submit click');
assert.match(postgresAdapter,
  /crossShopLegacyPddReadOnlyRecovery,status[\s\S]*binding\.actual_shop_name = shop\.expected_shop_name[\s\S]*effect\.status IN \('reserved','unknown'\)[\s\S]*effect\.effect_type = 'pdd-submit'[\s\S]*effect\.effect_type = 'evidence-upload'/,
  'state-only reconciliation must retain the live identity and external-effect safety fence');
assert.match(workflow,
  /pddStateOnlyReconciliation = reconcileExternalEffectTypes\.size === 0[\s\S]*effectType: 'pdd-state'[\s\S]*pdd-detail-state-only-read-back/,
  'a reconciliation without an external effect must be classified as a state-only readback');
assert.match(workflow,
  /pddStateOnlyReconciliation[\s\S]*pddResolutionSubmission: null[\s\S]*pending-page-confirmed[\s\S]*externalActionsReplayed: false/,
  'a pending state-only readback must resume the original workflow without fabricating a PDD submit attempt');
assert.match(postgresAdapter,
  /retryablePddStateNotApplied[\s\S]*reconciledEffectType === 'pdd-state'[\s\S]*pdd-state-not-applied/,
  'a pending state-only readback may resume automation without treating a confirmed page as a replay');
assert.match(postgresAdapter,
  /!continuationReconciliation && confirmed[\s\S]*UPDATE ordinary_work_order_instances SET[\s\S]*status = 'archived'[\s\S]*current_step = 'external-state-confirmed'[\s\S]*promoteNextDeferredOrdinaryInstance/,
  'a terminal read-only confirmation must archive the current ordinary instance before promoting a deferred one');
assert.match(workflow,
  /evidenceUploadOnlyReconciliation[\s\S]*effectType: 'evidence-upload'[\s\S]*pdd-evidence-not-applied[\s\S]*crossShopPddEvidenceReadOnlyRecovery[\s\S]*externalActionsReplayed: false/,
  'an evidence-only readback must stay read-only and must not fabricate a PDD submit attempt');
assert.match(postgresAdapter,
  /retryablePddEvidenceNotApplied[\s\S]*reconciledEffectType === 'evidence-upload'[\s\S]*pdd-evidence-not-applied[\s\S]*worker-read-only-reconciliation-resolved/,
  'a confirmed pending detail may release only the unknown evidence effect for a safe retry and resolve stale manual handoff');
assert.match(submitCompleteButtonPauseRecoveryMigration,
  /ffa7c2df-c4bf-4e98-8511-9e2bb6dcce9c[\s\S]*shop-mt9va8ol-47962e[\s\S]*260901-089422579342570[\s\S]*fb6bb018-49b7-447b-82e4-d9b88fbc5df4[\s\S]*500013140478952[\s\S]*shipped-no-tracking-refund[\s\S]*43946/,
  'migration 290 must target only the inspected work order, instance, platform case, scenario, and TMS ticket');
assert.match(submitCompleteButtonPauseRecoveryMigration,
  /scenario_code <> 'product-shortage'[\s\S]*manual_review_reason LIKE[\s\S]*PDD_ORDINARY_SUBMIT_RENDER_TEMPORARILY_UNAVAILABLE[\s\S]*instance\.identity_status = 'verified'[\s\S]*binding\.actual_shop_name = shop\.expected_shop_name[\s\S]*binding\.binding_token::text/,
  'migration 290 must require the exact old pause, verified instance identity, and current shop binding');
assert.match(submitCompleteButtonPauseRecoveryMigration,
  /pddResolutionSubmission,status\}' =\s*'render-retry'[\s\S]*submitEffectStage\}' =\s*'resolution'[\s\S]*submitAttemptCount[\s\S]*= 0[\s\S]*lastClickAttemptedAt\}'[\s\S]*IS NULL[\s\S]*pddResolutionRecovery,transientCode/,
  'migration 290 must prove that the final resolution never reached a click and only exhausted render retry state');
assert.match(submitCompleteButtonPauseRecoveryMigration,
  /effect\.effect_type = 'tms-create'[\s\S]*effect\.status = 'succeeded'[\s\S]*effect\.effect_type = 'pdd-note'[\s\S]*effect\.status = 'succeeded'[\s\S]*:handover'[\s\S]*effect\.status = 'failed'[\s\S]*:resolution'[\s\S]*clickAttempted' = 'false'/,
  'migration 290 must require successful TMS, note, and handover effects plus an unclicked failed resolution effect');
assert.match(submitCompleteButtonPauseRecoveryMigration,
  /effect\.error->>'name' = 'PddSubmitButtonRenderError'[\s\S]*manual_review_reason =[\s\S]*effect\.error->>'message'[\s\S]*4 = \([\s\S]*effect\.status IN \('reserved', 'unknown'\)[\s\S]*runtime\.lease_expires_at > now\(\)/,
  'migration 290 must require exactly the inspected effects and exclude uncertain effects and active leases');
assert.doesNotMatch(submitCompleteButtonPauseRecoveryMigration,
  /(?:UPDATE|DELETE FROM)\s+(?:external_effects|tms_work_orders)/iu,
  'migration 290 must never change successful or failed external-effect and TMS history');
assert.match(submitCompleteButtonPauseRecoveryMigration,
  /pdd-submit-complete-button-recovery-ready[\s\S]*- 'transientWorkflowRecovery'[\s\S]*- 'pddResolutionRecovery'[\s\S]*- 'pddSubmitButtonLookupFailure'[\s\S]*- 'pddResolutionSubmission'[\s\S]*successfulPriorEffectsPreserved', true[\s\S]*failedResolutionClickAttempted', false[\s\S]*externalActionsReplayedByMigration', false/,
  'migration 290 must clear only stale render budgets while preserving successful effect evidence and replaying no action');
assert.match(submitCompleteButtonPauseRecoveryMigration,
  /intervention\.reason = recovered\.previous_reason[\s\S]*outbox\.status IN \('pending', 'sending', 'failed'\)[\s\S]*290_recover_submit_complete_button_pause\.sql/,
  'migration 290 must resolve only its matching intervention, cancel only unsent notices, and record its schema version');
assert.match(verifiedProactiveFrameSubmitPauseRecoveryMigration,
  /260817-532886393133616[\s\S]*260819-136629481001925[\s\S]*260820-132561058141738/,
  'migration 291 must target only the three inspected proactive-logistics orders');
assert.match(verifiedProactiveFrameSubmitPauseRecoveryMigration,
  /confirmedNotApplied\}' = 'true'[\s\S]*isPending\}' = 'true'[\s\S]*orderMatches\}' = 'true'[\s\S]*isExpectedWorkOrderType\}' = 'true'[\s\S]*present-in-pending-list'[\s\S]*proof\.proof_count = 6/,
  'migration 291 must require six exact read-only observations proving each legacy click was not applied');
assert.match(verifiedProactiveFrameSubmitPauseRecoveryMigration,
  /scenario_code = 'proactive-logistics-service'[\s\S]*scenario_code <> 'product-shortage'[\s\S]*instance\.identity_status = 'verified'[\s\S]*binding\.actual_shop_name = shop\.expected_shop_name[\s\S]*binding\.binding_token::text[\s\S]*recovery_state = 'held'[\s\S]*recovery_reason = 'external-state-still-uncertain'/,
  'migration 291 must require the exact scenario, verified instance identity, current shop binding, and exact reconciliation hold');
assert.match(verifiedProactiveFrameSubmitPauseRecoveryMigration,
  /binding\.binding_token::text = coalesce[\s\S]*OR \([\s\S]*binding\.mall_id = coalesce[\s\S]*FROM shops ambiguous_shop[\s\S]*ambiguous_shop\.expected_shop_name = binding\.actual_shop_name/,
  'migration 291 may rebind a rotated login token only when the verified instance mall identity matches and the shop name is unambiguous');
assert.match(verifiedProactiveFrameSubmitPauseRecoveryMigration,
  /unknown_effect\.status = 'unknown'[\s\S]*clickAttempted' = 'true'[\s\S]*requestCaptured' = 'false'[\s\S]*responseCaptured' = 'false'[\s\S]*1 = \([\s\S]*effect\.status = 'unknown'/,
  'migration 291 must require exactly one inspected unknown submit with no captured request or response');
assert.match(verifiedProactiveFrameSubmitPauseRecoveryMigration,
  /primary_effect\.status = 'succeeded'[\s\S]*result_effect\.status = 'succeeded'[\s\S]*submitReceipt,success\}' = 'true'[\s\S]*submitForm[\s\S]*runtime\.lease_expires_at > now\(\)/,
  'migration 291 must preserve successful prior stages and exclude active leases');
assert.match(verifiedProactiveFrameSubmitPauseRecoveryMigration,
  /-frame-submit-v3[\s\S]*SET status = 'failed'[\s\S]*confirmedNotApplied', true[\s\S]*UPDATE work_orders work_order[\s\S]*status = 'retry-ready'[\s\S]*identityBackfilledAt[\s\S]*frameSubmitRetryAuthorizedAt[\s\S]*bindingRebound'[\s\S]*successfulPriorEffectsPreserved', true[\s\S]*externalActionsReplayedByMigration', false/,
  'migration 291 must retire only confirmed-not-applied unknown effects and authorize one same-frame retry without replaying an action');
assert.match(verifiedProactiveFrameSubmitPauseRecoveryMigration,
  /intervention\.reason = recovered\.previous_reason[\s\S]*outbox\.status IN \('pending', 'sending', 'failed'\)[\s\S]*291_recover_verified_proactive_frame_submit_pauses\.sql/,
  'migration 291 must resolve only matching interventions, cancel only unsent notices, and record its schema version');
assert.match(deliveryRiskConsumerConfirmationMigration,
  /986a3f8a-94b7-4ef6-9953-2ba4b633ad5e[\s\S]*shop-mt9vci3e-20eedf[\s\S]*260828-638341661110347[\s\S]*e1d33f4f-f651-46e1-99be-282fa174044f[\s\S]*500013129117919[\s\S]*dfc6b17b-d7a2-462e-a3dd-88d91c1ae2a7/,
  'migration 292 must target only the inspected order, instance, platform case, shop, and failed submit');
assert.match(deliveryRiskConsumerConfirmationMigration,
  /scenario_code = 'delivery-risk-concern'[\s\S]*scenario_code <> 'product-shortage'[\s\S]*external-state-still-uncertain[\s\S]*identity_status = 'verified'[\s\S]*binding\.actual_shop_name = shop\.expected_shop_name[\s\S]*binding\.binding_token::text = coalesce/,
  'migration 292 must require the exact scenario, verified identity, current binding, and old hold');
assert.match(deliveryRiskConsumerConfirmationMigration,
  /failed_effect\.status = 'failed'[\s\S]*clickAttempted' = 'true'[\s\S]*requestCaptured' = 'true'[\s\S]*responseCaptured' = 'true'[\s\S]*errorCode' = '190001'[\s\S]*该订单物流状态异常，请先和消费者确认[\s\S]*pddResolutionSubmission,reservationAttemptCount\}' = '2'/u,
  'migration 292 must require the exact captured platform rejection and exhausted reservation count');
assert.match(deliveryRiskConsumerConfirmationMigration,
  /confirmedNotApplied\}' = 'true'[\s\S]*isPending\}' = 'true'[\s\S]*orderMatches\}' = 'true'[\s\S]*isExpectedWorkOrderType\}' = 'true'[\s\S]*present-in-pending-list'[\s\S]*proof\.proof_count = 6/,
  'migration 292 must require six exact pending-list observations proving the failed submit was not applied');
assert.match(deliveryRiskConsumerConfirmationMigration,
  /收件地址不详[\s\S]*暂时无法为您配送[\s\S]*effect\.status IN \('reserved', 'unknown'\)[\s\S]*runtime\.lease_expires_at > now\(\)/u,
  'migration 292 must require the blocking logistics trace, no uncertain effects, and no active lease');
assert.doesNotMatch(deliveryRiskConsumerConfirmationMigration,
  /(?:UPDATE|DELETE FROM)\s+(?:external_effects|tms_work_orders)/iu,
  'migration 292 must preserve all external-effect and TMS history');
assert.match(deliveryRiskConsumerConfirmationMigration,
  /current_step = 'manual-review-blocked'[\s\S]*classification_reason = 'delivery-risk-consumer-confirmation-required'[\s\S]*- 'externalStateReconciliation'[\s\S]*automaticRetryAuthorized', false[\s\S]*failedEffectPreserved', true[\s\S]*externalActionsReplayedByMigration', false/,
  'migration 292 must replace only the stale reconciliation hold with the explicit consumer-confirmation boundary');
assert.match(deliveryRiskConsumerConfirmationMigration,
  /UPDATE manual_interventions intervention[\s\S]*reason = instance\.manual_review_reason[\s\S]*risk_level = 'high'[\s\S]*292_reclassify_delivery_risk_consumer_confirmation\.sql/,
  'migration 292 must update existing intervention wording without enqueueing or sending a new notification');
assert.match(staging, /stop_grace_period: 3m/);
assert.match(startScript, /--wait-timeout/);
assert.match(stopScript, /Draining active work orders and stopping workers/);
assert.match(stopScript, /down', '--timeout', '60'/);
assert.match(workerPreflight, /FROM shops WHERE enabled IS TRUE/);
assert.match(workerPreflight, /rows\.shops < 1/);
assert.match(workerPreflight, /rows\.enabled_shops < 1/);
assert.doesNotMatch(workerPreflight, /rows\.shops !== \d+/,
  'server preflight must not cap the number of shops');

console.log('continuous worker, command handling and external-effect guard self-test passed');
