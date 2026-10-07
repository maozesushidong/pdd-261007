export const DEFAULT_PDD_RENDER_WAIT_MS = 30_000;

export const hasExactPddOrderQueryEmptyResult = (pageText) => {
  const normalized = String(pageText || '').replace(/\s+/gu, ' ');
  return /\u5171\u67e5\u8be2\u5230\s*0\s*\u4e2a\u5de5\u5355/u.test(normalized)
    && /\u6682\u65e0\u5de5\u5355/u.test(normalized);
};

export const needsFreshPddDetailLookup = (progress = {}) => {
  const reasons = [
    typeof progress.error === 'string' ? progress.error : progress.error?.message,
    progress.manualReview?.reason,
    progress.transientWorkflowRecovery?.lastReason,
    progress.ordinaryDetailRenderRecovery199?.previousReason,
    progress.ordinaryDetailRenderRecovery200?.previousReason,
    progress.ordinaryDetailFreshQueryRecovery213?.previousReason,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  return reasons.some((reason) => (
    /^\u62fc\u591a\u591a\u666e\u901a\u5de5\u5355\u8be6\u60c5\u8ba2\u5355\u53f7\u6e32\u67d3\u5237\u65b0\u540e\u7b49\u5f85 \d+ \u6beb\u79d2\u4ecd\u672a\u51fa\u73b0\u6709\u6548\u7ed3\u679c$/u.test(reason)
    || /^\u666e\u901a\u5de5\u5355\u8be6\u60c5\u8ba2\u5355\u53f7\u4e0d\u4e00\u81f4: \u671f\u671b \d+(?:-\d+)+\uff0c\u5b9e\u9645 \u672a\u8bfb\u53d6\u5230$/u.test(reason)
  ));
};

const pddLoadingSelector = [
  '[aria-busy="true"]',
  '.ant-spin-spinning',
  '.ant-spin-dot-spin',
  '.beast-core-loading',
  '[class*="loading-mask" i]',
  '[class*="loading-overlay" i]',
  '[class*="loadingOverlay"]',
].join(', ');

export const hasVisiblePddLoadingState = async (page) => {
  const loadingElements = page.locator(pddLoadingSelector);
  const count = Math.min(30, await loadingElements.count().catch(() => 0));
  for (let index = 0; index < count; index += 1) {
    if (await loadingElements.nth(index).isVisible().catch(() => false)) return true;
  }

  const loadingText = page.getByText(/^(?:加载中|正在加载|数据加载中)[.。…·]*$/u);
  const textCount = Math.min(10, await loadingText.count().catch(() => 0));
  for (let index = 0; index < textCount; index += 1) {
    if (await loadingText.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
};

export class PddRenderWaitTimeoutError extends Error {
  constructor(stage, timeoutMs, diagnostics = {}) {
    super(`拼多多${stage}刷新后等待 ${timeoutMs} 毫秒仍未出现有效结果`);
    this.name = 'PddRenderWaitTimeoutError';
    this.code = 'PDD_RENDER_WAIT_TIMEOUT';
    this.stage = stage;
    this.timeoutMs = timeoutMs;
    this.retryable = true;
    this.diagnostics = diagnostics;
  }
}

const validateNonNegativeInteger = (name, value) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
};

export const waitForPddRenderedResult = async (page, {
  inspect,
  stage = '页面渲染',
  timeoutMs = DEFAULT_PDD_RENDER_WAIT_MS,
  totalTimeoutMs = null,
  initialWaitMs = null,
  pollIntervalMs = 300,
  onVerification = null,
  beforeReload = null,
  onRefresh = null,
  refreshOnInitialResult = null,
  // PDD may keep secondary resources open after the document is usable. The
  // caller still verifies rendered content below, so waiting for commit avoids
  // turning a usable page into a navigation timeout.
  reloadOptions = { waitUntil: 'commit', timeout: 45_000 },
} = {}) => {
  if (typeof inspect !== 'function') throw new Error('inspect must be a function');
  if (refreshOnInitialResult != null && typeof refreshOnInitialResult !== 'function') {
    throw new Error('refreshOnInitialResult must be a function');
  }
  validateNonNegativeInteger('timeoutMs', timeoutMs);
  validateNonNegativeInteger('pollIntervalMs', pollIntervalMs);
  if (totalTimeoutMs != null) validateNonNegativeInteger('totalTimeoutMs', totalTimeoutMs);
  if (initialWaitMs != null) validateNonNegativeInteger('initialWaitMs', initialWaitMs);

  const boundedTotalTimeoutMs = totalTimeoutMs == null ? null : totalTimeoutMs;
  const boundedInitialWaitMs = boundedTotalTimeoutMs == null
    ? timeoutMs
    : Math.min(
      boundedTotalTimeoutMs,
      initialWaitMs == null
        ? Math.ceil(boundedTotalTimeoutMs * (2 / 3))
        : initialWaitMs,
    );
  const startedAt = Date.now();
  let verificationWaitMs = 0;
  let totalDeadline = boundedTotalTimeoutMs == null
    ? null
    : startedAt + boundedTotalTimeoutMs;

  const excludeFromBudget = async (operation) => {
    const excludedStartedAt = Date.now();
    try {
      return await operation();
    } finally {
      const excludedElapsedMs = Math.max(0, Date.now() - excludedStartedAt);
      verificationWaitMs += excludedElapsedMs;
      if (totalDeadline != null) totalDeadline += excludedElapsedMs;
    }
  };

  const waitOnce = async (phase, phaseTimeoutMs) => {
    let deadline = Date.now() + phaseTimeoutMs;
    if (totalDeadline != null) deadline = Math.min(deadline, totalDeadline);
    do {
      const verificationStartedAt = Date.now();
      await excludeFromBudget(() => onVerification?.(page, `${stage}-${phase}`));
      const verificationElapsedMs = Math.max(0, Date.now() - verificationStartedAt);
      deadline += verificationElapsedMs;

      const result = await inspect(page, { phase });
      if (result) return result;

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await page.waitForTimeout(Math.min(Math.max(1, pollIntervalMs), remainingMs));
    } while (Date.now() < deadline);
    return null;
  };

  const initialResult = await waitOnce('initial', boundedInitialWaitMs);
  if (initialResult && !refreshOnInitialResult?.(initialResult)) {
    return { ...initialResult, refreshed: false };
  }

  let refreshRemainingMs = totalDeadline == null
    ? null
    : Math.max(0, totalDeadline - Date.now());
  if (refreshRemainingMs === 0) {
    throw new PddRenderWaitTimeoutError(stage, boundedTotalTimeoutMs, {
      elapsedMs: Math.max(0, Date.now() - startedAt - verificationWaitMs),
      initialWaitMs: boundedInitialWaitMs,
      refreshed: false,
      totalBudget: true,
    });
  }

  // PDD may show a scoped modal with a central "刷新" action after a detail
  // view has been open for too long. Prefer that in-place recovery when the
  // caller can identify it; only fall back to a full reload when it cannot.
  let preReloadResult = null;
  if (typeof beforeReload === 'function' && refreshRemainingMs > 0) {
    preReloadResult = await beforeReload(page, {
      remainingMs: refreshRemainingMs,
      totalDeadline,
      excludeFromBudget,
    }).catch(() => null);
  }
  if (preReloadResult?.handled !== true) {
    const effectiveReloadOptions = refreshRemainingMs == null
      ? reloadOptions
      : {
        ...reloadOptions,
        timeout: Math.max(1, Math.min(
          Number(reloadOptions?.timeout) || refreshRemainingMs,
          refreshRemainingMs,
        )),
      };
    try {
      await page.reload(effectiveReloadOptions);
    } catch (error) {
      const budgetExpired = totalDeadline != null && Date.now() >= totalDeadline;
      if (!budgetExpired || !/Timeout/iu.test(String(error?.message || error))) throw error;
    }
  }
  refreshRemainingMs = totalDeadline == null
    ? timeoutMs
    : Math.max(0, totalDeadline - Date.now());
  if (refreshRemainingMs > 0) {
    await onRefresh?.(page, {
      remainingMs: refreshRemainingMs,
      totalDeadline,
      excludeFromBudget,
    });
  }

  refreshRemainingMs = totalDeadline == null
    ? timeoutMs
    : Math.max(0, totalDeadline - Date.now());
  // Always perform one final DOM inspection after refresh. This does not add
  // another wait window, but avoids missing content that became ready exactly
  // as the shared render budget expired.
  const refreshedResult = await waitOnce('refreshed', refreshRemainingMs);
  if (refreshedResult) return { ...refreshedResult, refreshed: true };
  throw new PddRenderWaitTimeoutError(stage, boundedTotalTimeoutMs ?? timeoutMs, {
    elapsedMs: Math.max(0, Date.now() - startedAt - verificationWaitMs),
    initialWaitMs: boundedInitialWaitMs,
    refreshed: true,
    totalBudget: boundedTotalTimeoutMs != null,
  });
};
