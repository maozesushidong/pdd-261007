const retryablePostgresCheckpointCodes = new Set(['40P01', '40001']);

const defaultWait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

export function postgresCheckpointErrorCode(error) {
  const code = error?.code || error?.cause?.code;
  return String(code || '').trim().toUpperCase();
}

export async function retryPostgresCheckpoint(
  operation,
  {
    retryDelaysMs = [25, 75],
    wait = defaultWait,
    onRetry = null,
  } = {},
) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  const delays = retryDelaysMs.map((value) => Math.max(0, Number(value) || 0));
  let attempt = 1;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      const code = postgresCheckpointErrorCode(error);
      const delayMs = delays[attempt - 1];
      if (!retryablePostgresCheckpointCodes.has(code) || delayMs === undefined) throw error;
      onRetry?.({
        attempt: attempt + 1,
        maxAttempts: delays.length + 1,
        code,
        delayMs,
      });
      await wait(delayMs);
      attempt += 1;
    }
  }
}
