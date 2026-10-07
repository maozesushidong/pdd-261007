const activeVerificationStatuses = new Set([
  'detected',
  'waiting-human',
  'verification-required',
]);

const normalizedStatus = (value) => String(value || '').trim().toLowerCase();

const timestampMs = (value) => {
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const isAuthenticatedPddUrl = (value) => {
  try {
    const parsed = new URL(String(value || '').trim());
    return parsed.protocol === 'https:'
      && parsed.hostname === 'mms.pinduoduo.com'
      && !parsed.pathname.startsWith('/login');
  } catch {
    return false;
  }
};

export const isHumanVerificationInterruptionReason = (reason) => (
  /检测到人工验证[\s\S]*(?:重新运行|完成后)/u.test(String(reason || ''))
);

export const classifyClearedResidentVerification = ({
  progress = {},
  leaseToken = '',
  claimHydratedAtMs = null,
} = {}) => {
  const command = progress.residentCommand || {};
  const recheck = progress.verificationRecheck || {};
  const runtimeObservation = progress.runtimeObservation || {};
  const commandAssignmentId = String(command.assignmentId || '').trim();
  const expectedAssignmentId = String(leaseToken || '').trim();
  const commandCompletedAtMs = timestampMs(command.completedAt);
  const recheckCompletedAt = recheck.completedAt || recheck.clearedAt || null;
  const recheckCompletedAtMs = timestampMs(recheckCompletedAt);
  const runtimeObservedAt = runtimeObservation.observedAt || progress.authHealth?.pdd?.checkedAt || null;
  const runtimeObservedAtMs = timestampMs(runtimeObservedAt);
  const hydratedAtMs = Number(claimHydratedAtMs);
  const freshAfterAssignment = recheckCompletedAtMs !== null
    && commandCompletedAtMs !== null
    && recheckCompletedAtMs >= commandCompletedAtMs
    && (!Number.isFinite(hydratedAtMs) || recheckCompletedAtMs >= hydratedAtMs);
  const postCommandAuthenticatedObservation = progress.step === 'pdd-session-recovered'
    && progress.authHealth?.pdd?.status === 'authenticated'
    && runtimeObservedAtMs !== null
    && commandCompletedAtMs !== null
    && runtimeObservedAtMs >= commandCompletedAtMs
    && (!Number.isFinite(hydratedAtMs) || runtimeObservedAtMs >= hydratedAtMs);

  if (command.status !== 'idle'
    || command.outcome !== 'verification-required'
    || !expectedAssignmentId
    || commandAssignmentId !== expectedAssignmentId
    || recheck.status !== 'cleared'
    || progress.verificationLocation
    || (!freshAfterAssignment && !postCommandAuthenticatedObservation)) return null;

  return {
    state: 'resolved',
    source: freshAfterAssignment
      ? 'resident-browser-live-pages'
      : 'resident-browser-post-command-authenticated',
    verificationId: recheck.verificationId || null,
    stage: progress.verificationStage || null,
    status: 'resolved',
    detectedAt: recheck.detectedAt || null,
    resolvedAt: freshAfterAssignment ? recheckCompletedAt : runtimeObservedAt,
  };
};

export const classifyWaitingResidentVerification = ({
  progress = {},
  leaseToken = '',
  claimHydratedAtMs = null,
  clockSkewMs = 5_000,
} = {}) => {
  const command = progress.residentCommand || {};
  const commandAssignmentId = String(command.assignmentId || '').trim();
  const expectedAssignmentId = String(leaseToken || '').trim();
  const commandCompletedAtMs = timestampMs(command.completedAt);
  const hydratedAtMs = Number(claimHydratedAtMs);
  const commandIsCurrent = command.status === 'idle'
    && command.outcome === 'verification-required'
    && expectedAssignmentId
    && commandAssignmentId === expectedAssignmentId
    && commandCompletedAtMs !== null
    && (!Number.isFinite(hydratedAtMs)
      || commandCompletedAtMs >= hydratedAtMs - Math.max(0, clockSkewMs));
  if (!commandIsCurrent) return null;

  const progressClassification = progress.verificationLocation
    ? classifySnapshot(verificationSnapshot(progress.verificationLocation), 'progress')
    : null;
  if (progressClassification?.state === 'waiting') {
    const detectedAtMs = timestampMs(progressClassification.detectedAt);
    if (!Number.isFinite(hydratedAtMs)
      || (detectedAtMs !== null
        && detectedAtMs >= hydratedAtMs - Math.max(0, clockSkewMs))) {
      return progressClassification;
    }
  }

  const authStillBlocked = progress.step === 'human-verification-required'
    && progress.authHealth?.pdd?.status === 'verification-required';
  if (!authStillBlocked) return null;
  return {
    state: 'waiting',
    source: 'resident-command',
    verificationId: null,
    stage: progress.verificationStage || null,
    status: 'verification-required',
    detectedAt: null,
    resolvedAt: null,
  };
};

export const classifyResidentLoginInterruption = ({
  progress = {},
  leaseToken = '',
  claimHydratedAtMs = null,
  clockSkewMs = 5_000,
} = {}) => {
  const command = progress.residentCommand || {};
  const commandAssignmentId = String(command.assignmentId || '').trim();
  const expectedAssignmentId = String(leaseToken || '').trim();
  const commandCompletedAtMs = timestampMs(command.completedAt);
  const hydratedAtMs = Number(claimHydratedAtMs);
  const commandIsCurrent = command.status === 'idle'
    && command.outcome === 'login-required'
    && expectedAssignmentId
    && commandAssignmentId === expectedAssignmentId
    && commandCompletedAtMs !== null
    && (!Number.isFinite(hydratedAtMs)
      || commandCompletedAtMs >= hydratedAtMs - Math.max(0, clockSkewMs));
  if (!commandIsCurrent) return null;

  const pddHealth = progress.authHealth?.pdd || {};
  const loginSystem = normalizedStatus(progress.systemLogin?.system);
  const loginStatus = normalizedStatus(progress.systemLogin?.status);
  if (progress.step === 'manual-login-required'
    && pddHealth.status === 'expired'
    && loginSystem === 'pdd'
    && loginStatus === 'required') {
    return {
      state: 'waiting',
      source: 'resident-command',
      system: 'pdd',
      stage: progress.systemLogin?.stage || progress.verificationStage || 'pinduoduo-login',
      detectedAt: progress.systemLogin?.detectedAt || null,
      resolvedAt: null,
    };
  }

  const runtimeObservation = progress.runtimeObservation || {};
  const recoveredAt = runtimeObservation.observedAt || pddHealth.checkedAt || null;
  const recoveredAtMs = timestampMs(recoveredAt);
  if (progress.step === 'pdd-session-recovered'
    && pddHealth.status === 'authenticated'
    && recoveredAtMs !== null
    && recoveredAtMs >= commandCompletedAtMs) {
    return {
      state: 'resolved',
      source: runtimeObservation.source || 'resident-browser-authenticated',
      system: 'pdd',
      stage: progress.systemLogin?.stage || progress.verificationStage || 'pinduoduo-login',
      detectedAt: progress.systemLogin?.detectedAt || null,
      resolvedAt: recoveredAt,
    };
  }
  return null;
};

export const classifyDetachedClearedReturnRefundVerification = ({
  progress = {},
} = {}) => {
  const residentCommand = progress.residentCommand || {};
  const command = residentCommand.action === 'run-refund'
    && residentCommand.status === 'idle'
    && residentCommand.outcome === 'verification-required'
    ? residentCommand
    : progress.lastVerificationResidentCommand || {};
  const recheck = progress.verificationRecheck || {};
  const runtimeObservation = progress.runtimeObservation || {};
  const assignmentId = String(command.assignmentId || '').trim();
  const verificationId = String(recheck.verificationId || '').trim();
  const commandCompletedAtMs = timestampMs(command.completedAt);
  const detectedAtMs = timestampMs(recheck.detectedAt);
  const resolvedAt = recheck.completedAt || recheck.clearedAt || null;
  const resolvedAtMs = timestampMs(resolvedAt);
  const runtimeObservedAt = runtimeObservation.observedAt
    || progress.authHealth?.pdd?.checkedAt
    || null;
  const runtimeObservedAtMs = timestampMs(runtimeObservedAt);
  const exactResidentClear = command.action === 'run-refund'
    && command.status === 'idle'
    && command.outcome === 'verification-required'
    && recheck.trigger === 'resident-browser-live-pages'
    && recheck.status === 'cleared'
    && !progress.verificationLocation;
  const freshForCommand = resolvedAtMs !== null
    && commandCompletedAtMs !== null
    && resolvedAtMs >= commandCompletedAtMs
    && (detectedAtMs === null || resolvedAtMs >= detectedAtMs);
  const postCommandAuthenticatedObservation = progress.authHealth?.pdd?.status === 'authenticated'
    && runtimeObservedAtMs !== null
    && commandCompletedAtMs !== null
    && runtimeObservedAtMs >= commandCompletedAtMs
    && (detectedAtMs === null || resolvedAtMs === null || resolvedAtMs >= detectedAtMs);

  if (!exactResidentClear
    || !assignmentId
    || !verificationId
    || (!freshForCommand && !postCommandAuthenticatedObservation)) return null;
  return {
    assignmentId,
    verificationId,
    commandCompletedAt: command.completedAt || null,
    detectedAt: recheck.detectedAt || null,
    resolvedAt: freshForCommand ? resolvedAt : runtimeObservedAt,
  };
};

export const classifyStalePreClaimVerificationGate = ({
  persistedVerification = null,
  progress = {},
  nowMs = Date.now(),
  graceMs = 60_000,
  runtimeFreshnessMs = 2 * 60_000,
} = {}) => {
  if (!persistedVerification) return null;
  const verificationId = String(
    persistedVerification.id || persistedVerification.verificationId || '',
  ).trim();
  const system = String(
    persistedVerification.system_name || persistedVerification.system || '',
  ).trim().toLowerCase();
  const workOrderId = String(
    persistedVerification.work_order_id || persistedVerification.workOrderId || '',
  ).trim();
  const status = normalizedStatus(persistedVerification.status);
  const resolvedAt = persistedVerification.resolved_at
    || persistedVerification.resolvedAt
    || null;
  const detectedAt = persistedVerification.detected_at
    || persistedVerification.detectedAt
    || null;
  const detectedAtMs = timestampMs(detectedAt);
  const authenticatedAt = progress.authHealth?.pdd?.checkedAt || null;
  const authenticatedAtMs = timestampMs(authenticatedAt);
  const runtimeObservation = progress.runtimeObservation || {};
  const runtimeObservedAt = runtimeObservation.observedAt || null;
  const runtimeObservedAtMs = timestampMs(runtimeObservedAt);
  const pddUrl = String(
    runtimeObservation.urls?.pdd || progress.systemTabs?.pdd?.url || '',
  ).trim();
  const normalizedNowMs = Number(nowMs);
  const observationAgeMs = Number.isFinite(normalizedNowMs)
    && runtimeObservedAtMs !== null
    ? normalizedNowMs - runtimeObservedAtMs
    : Number.POSITIVE_INFINITY;
  const activePersistedVerification = verificationId
    && system === 'pdd'
    && !workOrderId
    && activeVerificationStatuses.has(status)
    && !resolvedAt
    && detectedAtMs !== null;
  const browserProvesChallengeCleared = !progress.verificationLocation
    && progress.authHealth?.pdd?.status === 'authenticated'
    && authenticatedAtMs !== null
    && authenticatedAtMs >= detectedAtMs
    && runtimeObservedAtMs !== null
    && runtimeObservedAtMs >= detectedAtMs
    && runtimeObservation.source === 'resident-browser-live-pages'
    && /^https:\/\/mms\.pinduoduo\.com\//iu.test(pddUrl)
    && observationAgeMs >= -5_000
    && observationAgeMs <= Math.max(1_000, Number(runtimeFreshnessMs) || 0);
  const outsideDetectorRace = Number.isFinite(normalizedNowMs)
    && normalizedNowMs - detectedAtMs >= Math.max(0, Number(graceMs) || 0);

  if (!activePersistedVerification
    || !browserProvesChallengeCleared
    || !outsideDetectorRace) return null;
  return {
    verificationId,
    detectedAt: new Date(detectedAtMs).toISOString(),
    authenticatedAt: new Date(authenticatedAtMs).toISOString(),
    runtimeObservedAt: new Date(runtimeObservedAtMs).toISOString(),
    resolvedAt: new Date(normalizedNowMs).toISOString(),
    source: 'fresh-authenticated-resident-browser-without-challenge',
  };
};

export const classifyStaleBoundPreClaimVerificationGate = ({
  persistedVerification = null,
  progress = {},
  nowMs = Date.now(),
  graceMs = 60_000,
  runtimeFreshnessMs = 2 * 60_000,
} = {}) => {
  if (!persistedVerification) return null;
  const verificationId = String(
    persistedVerification.id || persistedVerification.verificationId || '',
  ).trim();
  const workOrderId = String(
    persistedVerification.work_order_id || persistedVerification.workOrderId || '',
  ).trim();
  const system = normalizedStatus(
    persistedVerification.system_name || persistedVerification.system,
  );
  const status = normalizedStatus(persistedVerification.status);
  const resolvedAt = persistedVerification.resolved_at
    || persistedVerification.resolvedAt
    || null;
  const detectedAt = persistedVerification.detected_at
    || persistedVerification.detectedAt
    || null;
  const detectedAtMs = timestampMs(detectedAt);
  const authenticatedAt = progress.authHealth?.pdd?.checkedAt || null;
  const authenticatedAtMs = timestampMs(authenticatedAt);
  const runtimeObservation = progress.runtimeObservation || {};
  const runtimeObservedAt = runtimeObservation.observedAt || null;
  const runtimeObservedAtMs = timestampMs(runtimeObservedAt);
  const observedUrl = String(
    runtimeObservation.urls?.pdd || progress.systemTabs?.pdd?.url || '',
  ).trim();
  const normalizedNowMs = Number(nowMs);
  const observationAgeMs = Number.isFinite(normalizedNowMs)
    && runtimeObservedAtMs !== null
    ? normalizedNowMs - runtimeObservedAtMs
    : Number.POSITIVE_INFINITY;
  const activeBoundVerification = verificationId
    && workOrderId
    && system === 'pdd'
    && activeVerificationStatuses.has(status)
    && !resolvedAt
    && detectedAtMs !== null;
  const browserProvesDetachedChallengeCleared = !progress.verificationLocation
    && progress.authHealth?.pdd?.status === 'authenticated'
    && authenticatedAtMs !== null
    && authenticatedAtMs >= detectedAtMs
    && runtimeObservedAtMs !== null
    && runtimeObservedAtMs >= detectedAtMs
    && runtimeObservation.source === 'resident-browser-live-pages'
    && isAuthenticatedPddUrl(observedUrl)
    && observationAgeMs >= -5_000
    && observationAgeMs <= Math.max(1_000, Number(runtimeFreshnessMs) || 0);
  const outsideDetectorRace = Number.isFinite(normalizedNowMs)
    && normalizedNowMs - detectedAtMs >= Math.max(0, Number(graceMs) || 0);

  if (!activeBoundVerification
    || !browserProvesDetachedChallengeCleared
    || !outsideDetectorRace) return null;
  return {
    verificationId,
    workOrderId,
    detectedAt: new Date(detectedAtMs).toISOString(),
    authenticatedAt: new Date(authenticatedAtMs).toISOString(),
    runtimeObservedAt: new Date(runtimeObservedAtMs).toISOString(),
    resolvedAt: new Date(normalizedNowMs).toISOString(),
    observedUrl,
    source: 'fresh-authenticated-resident-browser-without-detached-bound-challenge',
  };
};

export const classifyRestoredPreClaimVerification = ({
  persistedVerification = null,
  progress = {},
  nowMs = Date.now(),
  freshnessMs = 2 * 60_000,
} = {}) => {
  if (!persistedVerification) return null;
  const verificationId = String(
    persistedVerification.id || persistedVerification.verificationId || '',
  ).trim();
  const workOrderId = String(
    persistedVerification.work_order_id || persistedVerification.workOrderId || '',
  ).trim();
  const system = normalizedStatus(
    persistedVerification.system_name || persistedVerification.system,
  );
  const status = normalizedStatus(persistedVerification.status);
  const resolvedAt = persistedVerification.resolved_at
    || persistedVerification.resolvedAt
    || null;
  const detectedAt = persistedVerification.detected_at
    || persistedVerification.detectedAt
    || null;
  const detectedAtMs = timestampMs(detectedAt);
  const verificationUrl = String(
    persistedVerification.url || persistedVerification.verificationUrl || '',
  ).trim();
  const recovery = progress.verificationRecovery || {};
  const recheck = progress.verificationRecheck || {};
  const recoveryStartedAtMs = timestampMs(recovery.startedAt);
  const completedAt = recovery.completedAt || recheck.completedAt || recheck.clearedAt || null;
  const completedAtMs = timestampMs(completedAt);
  const authenticatedAt = recovery.authenticatedAt || progress.authHealth?.pdd?.checkedAt || null;
  const authenticatedAtMs = timestampMs(authenticatedAt);
  const normalizedNowMs = Number(nowMs);
  const completionAgeMs = Number.isFinite(normalizedNowMs) && completedAtMs !== null
    ? normalizedNowMs - completedAtMs
    : Number.POSITIVE_INFINITY;
  const matchingRecovery = recovery.trigger === 'resident-browser-restart-recovery'
    && recovery.status === 'cleared'
    && String(recovery.verificationId || '').trim() === verificationId
    && String(recovery.workOrderId || '').trim() === workOrderId
    && String(recovery.verificationUrl || '').trim() === verificationUrl
    && recovery.externalActionsReplayed === false
    && recheck.trigger === 'resident-browser-restart-recovery'
    && recheck.status === 'cleared'
    && String(recheck.verificationId || '').trim() === verificationId
    && String(recheck.workOrderId || '').trim() === workOrderId
    && recheck.externalActionsReplayed === false;
  const freshAuthenticatedEvidence = progress.authHealth?.pdd?.status === 'authenticated'
    && isAuthenticatedPddUrl(recovery.observedUrl)
    && authenticatedAtMs !== null
    && recoveryStartedAtMs !== null
    && authenticatedAtMs >= recoveryStartedAtMs
    && completedAtMs !== null
    && completedAtMs >= recoveryStartedAtMs
    && (detectedAtMs === null || recoveryStartedAtMs >= detectedAtMs)
    && completionAgeMs >= -5_000
    && completionAgeMs <= Math.max(1_000, Number(freshnessMs) || 0);

  if (!verificationId
    || !workOrderId
    || system !== 'pdd'
    || !activeVerificationStatuses.has(status)
    || resolvedAt
    || progress.verificationLocation
    || !matchingRecovery
    || !freshAuthenticatedEvidence) return null;

  return {
    verificationId,
    workOrderId,
    detectedAt,
    recoveryStartedAt: recovery.startedAt,
    authenticatedAt,
    resolvedAt: completedAt,
    verificationUrl,
    observedUrl: String(recovery.observedUrl || progress.authHealth?.pdd?.url || '').trim(),
    source: 'resident-browser-restart-recovery',
  };
};

export const shouldReusePreClaimVerificationRecovery = ({
  recovery = {},
  residentCommand = {},
  progress = {},
  verificationId = '',
  workOrderId = '',
  nowMs = Date.now(),
  clearedFreshnessMs = 2 * 60_000,
  restoringFreshnessMs = 2 * 60_000,
} = {}) => {
  const normalizedVerificationId = String(verificationId || '').trim();
  const normalizedWorkOrderId = String(workOrderId || '').trim();
  const sameRecovery = normalizedVerificationId
    && normalizedWorkOrderId
    && String(recovery.verificationId || '').trim() === normalizedVerificationId
    && String(recovery.workOrderId || '').trim() === normalizedWorkOrderId;
  const sameCommand = residentCommand.action === 'restore-verification'
    && String(residentCommand.verificationId || '').trim() === normalizedVerificationId
    && String(residentCommand.workOrderId || '').trim() === normalizedWorkOrderId
    && String(residentCommand.requestId || '').trim()
    && String(residentCommand.requestId || '').trim()
      === String(recovery.requestId || '').trim();
  if (!sameRecovery || !sameCommand) return false;
  if (residentCommand.status === 'active') return true;
  if (recovery.status === 'restoring') {
    const startedAtMs = timestampMs(recovery.startedAt);
    const normalizedNowMs = Number(nowMs);
    const ageMs = Number.isFinite(normalizedNowMs) && startedAtMs !== null
      ? normalizedNowMs - startedAtMs
      : Number.POSITIVE_INFINITY;
    return ageMs >= -5_000
      && ageMs <= Math.max(1_000, Number(restoringFreshnessMs) || 0);
  }
  if (recovery.status === 'waiting-human') {
    const progressVerificationId = String(progress.verificationLocation?.id || '').trim();
    const currentPddUrl = String(
      progress.runtimeObservation?.urls?.pdd
      || progress.systemTabs?.pdd?.url
      || progress.authHealth?.pdd?.url
      || '',
    ).trim();
    const verificationUrl = String(recovery.verificationUrl || '').trim();
    const samePage = (() => {
      try {
        const current = new URL(currentPddUrl);
        const expected = new URL(verificationUrl);
        current.hash = '';
        expected.hash = '';
        return current.href === expected.href;
      } catch {
        return false;
      }
    })();
    return progress.step === 'human-verification-required'
      && progressVerificationId === normalizedVerificationId
      && normalizedStatus(progress.verificationLocation?.status) !== 'resolved'
      && progress.authHealth?.pdd?.status === 'verification-required'
      && samePage;
  }
  if (recovery.status !== 'cleared'
    || recovery.trigger !== 'resident-browser-restart-recovery'
    || recovery.externalActionsReplayed !== false) return false;

  const startedAtMs = timestampMs(recovery.startedAt);
  const authenticatedAtMs = timestampMs(recovery.authenticatedAt);
  const completedAtMs = timestampMs(recovery.completedAt);
  const normalizedNowMs = Number(nowMs);
  const ageMs = Number.isFinite(normalizedNowMs) && completedAtMs !== null
    ? normalizedNowMs - completedAtMs
    : Number.POSITIVE_INFINITY;
  return startedAtMs !== null
    && authenticatedAtMs !== null
    && completedAtMs !== null
    && startedAtMs <= authenticatedAtMs
    && authenticatedAtMs <= completedAtMs
    && ageMs >= -5_000
    && ageMs <= Math.max(1_000, Number(clearedFreshnessMs) || 0);
};

const verificationSnapshot = (value = {}) => ({
  verificationId: value.id || null,
  stage: value.stage || null,
  status: normalizedStatus(value.status),
  detectedAt: value.detectedAt || value.detected_at || null,
  resolvedAt: value.resolvedAt || value.resolved_at || null,
});

const classifySnapshot = (snapshot, source) => {
  if (!snapshot) return null;
  if (activeVerificationStatuses.has(snapshot.status) && !snapshot.resolvedAt) {
    return { state: 'waiting', source, ...snapshot };
  }
  if (snapshot.status === 'resolved' || snapshot.resolvedAt) {
    return { state: 'resolved', source, ...snapshot };
  }
  return null;
};

export const classifyInterruptedVerification = ({
  progress = {},
  reason = '',
  persistedVerification = null,
  claimHydratedAtMs = null,
  clockSkewMs = 5_000,
} = {}) => {
  if (progress.step !== 'flow-paused') return null;

  const recheck = progress.verificationRecheck || {};
  const recheckCompletedAt = recheck.completedAt || recheck.clearedAt || null;
  const recheckCompletedAtMs = timestampMs(recheckCompletedAt);
  const hydratedAtMs = Number(claimHydratedAtMs);
  const freshClearedRecheck = recheck.status === 'cleared'
    && /(?:verification|manual-refresh|auto-refresh|resident-browser-live-pages)/iu
      .test(String(recheck.trigger || ''))
    && (!Number.isFinite(hydratedAtMs)
      || (recheckCompletedAtMs !== null
        && recheckCompletedAtMs >= hydratedAtMs - Math.max(0, clockSkewMs)));
  if (!progress.verificationLocation && freshClearedRecheck) {
    return {
      state: 'resolved',
      source: 'progress-recheck',
      verificationId: recheck.verificationId || null,
      stage: progress.verificationStage || null,
      status: 'resolved',
      detectedAt: recheck.detectedAt || null,
      resolvedAt: recheckCompletedAt,
    };
  }

  const progressClassification = progress.verificationLocation
    ? classifySnapshot(verificationSnapshot(progress.verificationLocation), 'progress')
    : null;
  if (progressClassification) return progressClassification;
  if (!isHumanVerificationInterruptionReason(reason)) return null;

  if (persistedVerification) {
    const snapshot = verificationSnapshot(persistedVerification);
    const detectedAtMs = timestampMs(snapshot.detectedAt);
    const resolvedAtMs = timestampMs(snapshot.resolvedAt);
    const progressUpdatedAtMs = timestampMs(progress.updatedAt);
    const freshForClaim = !Number.isFinite(hydratedAtMs)
      || (detectedAtMs !== null && detectedAtMs >= hydratedAtMs - Math.max(0, clockSkewMs));
    if (freshForClaim) {
      const persistedClassification = classifySnapshot(snapshot, 'postgres');
      const resolvedBeforePause = persistedClassification?.state !== 'resolved'
        || progressUpdatedAtMs === null
        || (resolvedAtMs !== null && resolvedAtMs <= progressUpdatedAtMs - 250);
      if (persistedClassification && resolvedBeforePause) return persistedClassification;
    }
  }

  // The workflow error itself is authoritative evidence that a challenge
  // interrupted this claim. Without a fresh resolved record, keep the normal
  // verification backoff instead of turning the order into a permanent pause.
  return {
    state: 'waiting',
    source: 'workflow-error',
    verificationId: null,
    stage: progress.verificationStage || null,
    status: null,
    detectedAt: null,
    resolvedAt: null,
  };
};
