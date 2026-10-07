export const beginVerificationBudgetWindow = ({
  limitMs,
  consumedMs = 0,
  now = Date.now(),
} = {}) => {
  const normalizedLimit = Math.max(0, Number(limitMs) || 0);
  const normalizedConsumed = Math.max(0, Math.min(
    normalizedLimit,
    Number(consumedMs) || 0,
  ));
  const remainingMs = normalizedLimit > 0
    ? Math.max(0, normalizedLimit - normalizedConsumed)
    : null;
  return {
    limitMs: normalizedLimit,
    consumedMs: normalizedConsumed,
    remainingMs,
    startedAt: now,
    deadline: remainingMs === null ? null : now + remainingMs,
  };
};

export const consumeVerificationBudgetWindow = (window, {
  now = Date.now(),
} = {}) => {
  if (!window || window.limitMs <= 0) return Math.max(0, Number(window?.consumedMs) || 0);
  const elapsedMs = Math.max(0, now - window.startedAt);
  return Math.min(window.limitMs, window.consumedMs + elapsedMs);
};

export const waitForStableVerificationClear = async ({
  page,
  hasVerification,
  pollMs,
  stableMs,
  deadline = null,
  now = Date.now,
  consumeRefresh = null,
  onRefresh = null,
  maintainFocus = null,
  focusIntervalMs = 2000,
  focusQuantumMs = 0,
  shouldYieldFocus = null,
  autoRefresh = null,
  autoRefreshAfterMs = 0,
  maxAutoRefreshes = 0,
  onAutoRefresh = null,
  isExternallyCleared = null,
}) => {
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error('pollMs must be a positive number');
  if (!Number.isFinite(stableMs) || stableMs < 0) throw new Error('stableMs must be a non-negative number');
  if (consumeRefresh !== null && typeof consumeRefresh !== 'function') throw new Error('consumeRefresh must be a function');
  if (onRefresh !== null && typeof onRefresh !== 'function') throw new Error('onRefresh must be a function');
  if (maintainFocus !== null && typeof maintainFocus !== 'function') throw new Error('maintainFocus must be a function');
  if (maintainFocus && (!Number.isFinite(focusIntervalMs) || focusIntervalMs <= 0)) {
    throw new Error('focusIntervalMs must be a positive number');
  }
  if (!Number.isFinite(focusQuantumMs) || focusQuantumMs < 0) {
    throw new Error('focusQuantumMs must be a non-negative number');
  }
  if (shouldYieldFocus !== null && typeof shouldYieldFocus !== 'function') {
    throw new Error('shouldYieldFocus must be a function');
  }
  if (autoRefresh !== null && typeof autoRefresh !== 'function') throw new Error('autoRefresh must be a function');
  if (!Number.isFinite(autoRefreshAfterMs) || autoRefreshAfterMs < 0) {
    throw new Error('autoRefreshAfterMs must be a non-negative number');
  }
  if (!Number.isInteger(maxAutoRefreshes) || maxAutoRefreshes < 0) {
    throw new Error('maxAutoRefreshes must be a non-negative integer');
  }
  if (onAutoRefresh !== null && typeof onAutoRefresh !== 'function') throw new Error('onAutoRefresh must be a function');
  if (isExternallyCleared !== null && typeof isExternallyCleared !== 'function') {
    throw new Error('isExternallyCleared must be a function');
  }

  let clearSince = null;
  let latestRefresh = null;
  let latestAutoRefresh = null;
  let autoRefreshCount = 0;
  const focusAcquiredAt = now();
  let nextFocusAt = now() + focusIntervalMs;
  let nextAutoRefreshAt = autoRefresh && autoRefreshAfterMs > 0 && maxAutoRefreshes > 0
    ? now() + autoRefreshAfterMs
    : null;
  while (!deadline || now() < deadline) {
    try {
      await page.waitForTimeout(pollMs);
    } catch (error) {
      if (page.isClosed()) return { status: 'closed' };
      throw error;
    }
    if (page.isClosed()) return { status: 'closed' };

    const polledAt = now();
    if (maintainFocus && polledAt >= nextFocusAt) {
      await maintainFocus();
      nextFocusAt = polledAt + focusIntervalMs;
    }

    const refresh = consumeRefresh ? await consumeRefresh() : null;
    if (refresh) {
      clearSince = null;
      latestRefresh = refresh;
      if (nextAutoRefreshAt !== null) nextAutoRefreshAt = polledAt + autoRefreshAfterMs;
      if (onRefresh) await onRefresh(refresh);
    }

    const pageReady = await page.evaluate(() => (
      document.readyState !== 'loading' && Boolean(document.body)
    )).catch(() => false);
    const externallyCleared = !pageReady && isExternallyCleared
      ? Boolean(await isExternallyCleared())
      : false;
    if (!pageReady && !externallyCleared) {
      clearSince = null;
      continue;
    }

    const verificationPresent = pageReady ? await hasVerification(page) : false;
    if (verificationPresent) {
      clearSince = null;
      if (shouldYieldFocus
        && focusQuantumMs > 0
        && polledAt - focusAcquiredAt >= focusQuantumMs
        && await shouldYieldFocus()) {
        return {
          status: 'yielded',
          yieldedAt: polledAt,
          heldMs: polledAt - focusAcquiredAt,
        };
      }
      if (nextAutoRefreshAt !== null
        && polledAt >= nextAutoRefreshAt
        && autoRefreshCount < maxAutoRefreshes) {
        autoRefreshCount += 1;
        const triggeredAt = polledAt;
        latestAutoRefresh = await autoRefresh({
          attempt: autoRefreshCount,
          triggeredAt,
        });
        if (onAutoRefresh) await onAutoRefresh(latestAutoRefresh);
        nextAutoRefreshAt = autoRefreshCount < maxAutoRefreshes
          ? now() + autoRefreshAfterMs
          : null;
      }
      continue;
    }

    const checkedAt = now();
    if (clearSince === null) clearSince = checkedAt;
    if (checkedAt - clearSince >= stableMs) {
      return {
        status: 'cleared',
        clearedAt: checkedAt,
        ...(externallyCleared ? { externallyConfirmed: true } : {}),
        ...(latestRefresh ? { refresh: latestRefresh } : {}),
        ...(latestAutoRefresh ? { autoRefresh: latestAutoRefresh } : {}),
      };
    }
  }

  return { status: 'timeout' };
};
