const windowsAbnormalTerminationCodes = new Set([-1, 0xFFFFFFFF]);

export function normalizeBrowserProcessExitCode({
  code,
  browserHealthFailure = null,
  platform = process.platform,
  disconnectedExitCode = 90,
}) {
  if (browserHealthFailure) return disconnectedExitCode;
  const numericCode = Number(code);
  if (platform === 'win32'
    && Number.isFinite(numericCode)
    && windowsAbnormalTerminationCodes.has(numericCode)) {
    return disconnectedExitCode;
  }
  return code;
}

export function createBrowserHealthMonitor({
  heartbeatTimeoutMs,
  startupGraceMs,
  checkIntervalMs,
  onFailure,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let active = null;

  const fail = (reason, details = {}) => {
    if (!active || active.failed) return false;
    active.failed = true;
    const failure = {
      child: active.child,
      reason,
      startedAt: active.startedAt,
      lastHeartbeatAt: active.lastHeartbeatAt,
      ...details,
    };
    Promise.resolve(onFailure(failure)).catch((error) => {
      console.error(`[browser-health] recovery callback failed: ${error.message}`);
    });
    return true;
  };

  const check = () => {
    if (!active || active.failed) return false;
    const currentTime = now();
    const hasHeartbeat = Number.isFinite(active.lastHeartbeatAt);
    const baseline = hasHeartbeat ? active.lastHeartbeatAt : active.startedAt;
    const timeoutMs = hasHeartbeat ? heartbeatTimeoutMs : startupGraceMs;
    const ageMs = currentTime - baseline;
    if (ageMs < timeoutMs) return false;
    return fail(hasHeartbeat ? 'browser-heartbeat-timeout' : 'browser-heartbeat-startup-timeout', {
      ageMs,
      timeoutMs,
      lastMessage: active.lastMessage,
    });
  };

  const timer = setIntervalFn(check, checkIntervalMs);
  timer?.unref?.();

  return {
    attach(child) {
      active = {
        child,
        startedAt: now(),
        lastHeartbeatAt: null,
        lastMessage: null,
        failed: false,
      };
    },
    detach(child) {
      if (active?.child === child) active = null;
    },
    record(child, message) {
      if (message?.type !== 'browser-health' || active?.child !== child || active.failed) return false;
      active.lastHeartbeatAt = now();
      active.lastMessage = message;
      const pageCount = Number(message.pageCount);
      if (message.healthy === false || message.connected === false) {
        fail(message.reason || 'browser-health-reported-unhealthy', { lastMessage: message });
      } else if (Number.isFinite(pageCount) && pageCount < 1) {
        fail('browser-health-no-pages', { lastMessage: message });
      }
      return true;
    },
    check,
    close() {
      active = null;
      clearIntervalFn(timer);
    },
  };
}
