const defaultDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const isTransientBrowserNavigationError = (error) => (
  /Execution context was destroyed(?:, most likely because of a navigation)?|Cannot find context with specified id|frame was detached/iu
    .test(String(error?.message || error || ''))
);

export const retryTransientBrowserOperation = async (operation, {
  maxAttempts = 4,
  initialDelayMs = 150,
  delay = defaultDelay,
} = {}) => {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('maxAttempts must be a positive integer');
  }
  if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0) {
    throw new TypeError('initialDelayMs must be a non-negative number');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation({ attempt, maxAttempts });
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientBrowserNavigationError(error)) throw error;
      await delay(initialDelayMs * attempt);
    }
  }
  throw new Error('browser operation retry loop ended unexpectedly');
};
