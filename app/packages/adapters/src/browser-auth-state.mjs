import { retryTransientBrowserOperation } from './browser-transient-operation.mjs';

const normalizeCookieDomain = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/^\.+/u, '');

const normalizeHostname = (value) => String(value || '').trim().toLowerCase();

const hostnameMatches = (hostname, allowedHostname) => {
  const normalized = normalizeHostname(hostname);
  const allowed = normalizeHostname(allowedHostname);
  return Boolean(normalized && allowed
    && (normalized === allowed || normalized.endsWith(`.${allowed}`)));
};

const cookieMatchesHosts = (cookie, allowedHosts) => {
  const domain = normalizeCookieDomain(cookie?.domain);
  return allowedHosts.some((hostname) => hostnameMatches(domain, hostname));
};

const originMatchesHosts = (origin, allowedHosts) => {
  try {
    const hostname = new URL(String(origin?.origin || '')).hostname;
    return allowedHosts.some((allowed) => hostnameMatches(hostname, allowed));
  } catch {
    return false;
  }
};

export const AUTH_STORAGE_HOSTS = Object.freeze({
  pdd: Object.freeze(['pinduoduo.com', 'yangkeduo.com']),
  oms: Object.freeze(['jeoms.com']),
  tms: Object.freeze(['tms.aipro123.top']),
});

const weakAuthEvidencePattern = /(?:idle-session-observer|idle-url-observer|url-only|unprobed|about:blank|loading-shell)/iu;

const authHealthTimestamp = (health) => {
  const parsed = Date.parse(String(health?.checkedAt || health?.observedAt || ''));
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

export const isWeakAuthHealthEvidence = (health = {}) => (
  String(health.confidence || '').toLowerCase() === 'weak'
  || weakAuthEvidencePattern.test([
    health.stage,
    health.source,
    health.evidence,
  ].filter(Boolean).join(' '))
);

const normalizedAuthHealth = (health = {}) => {
  if (!health || typeof health !== 'object') return null;
  if (health.status === 'expired' && isWeakAuthHealthEvidence(health)) {
    return {
      ...health,
      status: 'unknown',
      confidence: 'weak',
      evidence: health.evidence || 'login-url-only',
    };
  }
  return health;
};

export const mergeSystemAuthHealth = (previousValue, nextValue) => {
  const previous = normalizedAuthHealth(previousValue);
  const next = normalizedAuthHealth(nextValue);
  if (!previous) return next;
  if (!next) return previous;

  const nextIsWeak = isWeakAuthHealthEvidence(next);
  const previousIsConfirmed = !isWeakAuthHealthEvidence(previous)
    && ['authenticated', 'verification-required', 'expired', 'unreachable'].includes(String(previous.status || ''));
  if (nextIsWeak && previousIsConfirmed) {
    return {
      ...previous,
      lastObservation: next,
      observedAt: next.checkedAt || next.observedAt || null,
      observedUrl: next.url || null,
    };
  }

  if (authHealthTimestamp(next) < authHealthTimestamp(previous)) return previous;
  return next;
};

export const mergeAuthHealthMaps = (...maps) => {
  const merged = {};
  for (const map of maps) {
    if (!map || typeof map !== 'object') continue;
    for (const [system, health] of Object.entries(map)) {
      const next = mergeSystemAuthHealth(merged[system], health);
      if (next) merged[system] = next;
    }
  }
  return merged;
};

export const scopeBrowserStorageState = (state, allowedHosts) => {
  const hosts = [...new Set((allowedHosts || []).map(normalizeHostname).filter(Boolean))];
  if (!state || typeof state !== 'object' || !hosts.length) return { cookies: [], origins: [] };
  return {
    cookies: (state.cookies || []).filter((cookie) => cookieMatchesHosts(cookie, hosts)),
    origins: (state.origins || []).filter((origin) => originMatchesHosts(origin, hosts)),
  };
};

const cookiePartitionKey = (cookie) => {
  const partition = cookie?.partitionKey;
  if (!partition) return '';
  return typeof partition === 'string' ? partition : JSON.stringify(partition);
};

export const mergeBrowserStorageStates = (states) => {
  const cookies = new Map();
  const origins = new Map();
  for (const state of states || []) {
    if (!state || typeof state !== 'object') continue;
    for (const cookie of state.cookies || []) {
      const key = [cookie.name, cookie.domain, cookie.path, cookiePartitionKey(cookie)].join('\u0000');
      cookies.set(key, cookie);
    }
    for (const origin of state.origins || []) {
      const previous = origins.get(origin.origin);
      const localStorage = new Map((previous?.localStorage || [])
        .map((entry) => [entry.name, entry]));
      for (const entry of origin.localStorage || []) localStorage.set(entry.name, entry);
      origins.set(origin.origin, {
        origin: origin.origin,
        localStorage: [...localStorage.values()],
        ...(origin.indexedDB || previous?.indexedDB
          ? { indexedDB: origin.indexedDB || previous.indexedDB }
          : {}),
      });
    }
  }
  if (!cookies.size && !origins.size) return undefined;
  return { cookies: [...cookies.values()], origins: [...origins.values()] };
};

export const PDD_SESSION_MIN_USABLE_MS = 5 * 60_000;

const isUnexpiredCookie = (cookie, nowSeconds) => {
  const expires = Number(cookie?.expires);
  return !Number.isFinite(expires) || expires <= 0
    || expires > nowSeconds + PDD_SESSION_MIN_USABLE_MS / 1000;
};

export const hasUsablePddSessionCookie = (state, nowMs = Date.now()) => {
  const nowSeconds = Math.floor(Number(nowMs) / 1000);
  return scopeBrowserStorageState(state, AUTH_STORAGE_HOSTS.pdd).cookies.some((cookie) => (
    /^windows_app_shop_token(?:_\d+)?$/iu.test(String(cookie?.name || ''))
      && isUnexpiredCookie(cookie, nowSeconds)
  ));
};

export const pddStorageMatchesMallId = (state, expectedMallId) => {
  const expected = String(expectedMallId || '').trim();
  if (!/^\d{5,30}$/u.test(expected)) return false;
  const mallIds = new Set();
  let invalidIdentity = false;
  for (const origin of scopeBrowserStorageState(state, AUTH_STORAGE_HOSTS.pdd).origins) {
    for (const entry of origin.localStorage || []) {
      if (entry.name !== 'new_userinfo') continue;
      try {
        const info = JSON.parse(entry.value);
        const mallId = String(info?.mall_id ?? info?.mallId
          ?? info?.mall?.mall_id ?? info?.mall?.mallId ?? '').trim();
        if (/^\d{5,30}$/u.test(mallId)) mallIds.add(mallId);
        else invalidIdentity = true;
      } catch { invalidIdentity = true; }
    }
  }
  return !invalidIdentity && mallIds.size === 1 && mallIds.has(expected);
};

export const hasPddStorageData = (state) => {
  const scoped = scopeBrowserStorageState(state, AUTH_STORAGE_HOSTS.pdd);
  return scoped.cookies.length > 0 || scoped.origins.length > 0;
};

export const hasBrowserStorageData = (state) => Boolean(
  (state?.cookies || []).length || (state?.origins || []).length
);

const withoutIndexedDb = (state) => ({
  cookies: [...(state?.cookies || [])],
  origins: (state?.origins || []).map((origin) => ({
    origin: origin.origin,
    localStorage: [...(origin.localStorage || [])],
  })),
});

const isRecoverableStorageRestoreError = (error) => (
  /Error setting storage state|Unable to restore IndexedDB|Failed to get ServiceWorkerRegistration objects|document is in an invalid state|InvalidStateError|Internal error/iu
    .test(String(error?.message || error || ''))
);

const isClosedBrowserStorageRestoreError = (error) => (
  /Target page, context or browser has been closed|browser context is unavailable|connection is closed/iu
    .test(String(error?.message || error || ''))
);

export const restoreBrowserAuthFromSnapshots = async (
  browserContext,
  savedState,
  { replaceSystems = [] } = {},
) => {
  if (!savedState || !browserContext) return { restoredSystems: [], state: null };
  const replacedSystems = new Set((replaceSystems || [])
    .map((system) => String(system || '').trim().toLowerCase())
    .filter((system) => Object.hasOwn(AUTH_STORAGE_HOSTS, system)));
  const savedSystems = Object.entries(AUTH_STORAGE_HOSTS)
    .filter(([, hosts]) => hasBrowserStorageData(scopeBrowserStorageState(savedState, hosts)))
    .map(([system]) => system);
  let currentState;
  let currentStateReadError = null;
  try {
    currentState = await browserContext.storageState({ indexedDB: true });
  } catch (error) {
    if (isClosedBrowserStorageRestoreError(error) || !isRecoverableStorageRestoreError(error)) throw error;
    currentStateReadError = error;
    try {
      currentState = await browserContext.storageState();
    } catch (fallbackError) {
      if (isClosedBrowserStorageRestoreError(fallbackError)) throw fallbackError;
      return {
        restoredSystems: [],
        attemptedSystems: savedSystems,
        state: null,
        degraded: true,
        recovery: 'persistent-profile-retained',
        error: fallbackError.message,
      };
    }
  }
  const overlays = [];
  const restoredSystems = [];
  const currentPdd = scopeBrowserStorageState(currentState, AUTH_STORAGE_HOSTS.pdd);
  const savedPdd = scopeBrowserStorageState(savedState, AUTH_STORAGE_HOSTS.pdd);
  if (!hasUsablePddSessionCookie(currentPdd) && hasUsablePddSessionCookie(savedPdd)) {
    overlays.push(savedPdd);
    restoredSystems.push('pdd');
  }
  for (const system of ['oms', 'tms']) {
    const current = scopeBrowserStorageState(currentState, AUTH_STORAGE_HOSTS[system]);
    const saved = scopeBrowserStorageState(savedState, AUTH_STORAGE_HOSTS[system]);
    if (hasBrowserStorageData(saved)
      && (replacedSystems.has(system) || !hasBrowserStorageData(current))) {
      overlays.push(saved);
      restoredSystems.push(system);
    }
  }
  if (!overlays.length) {
    return {
      restoredSystems,
      state: currentState,
      ...(currentStateReadError ? {
        degraded: true,
        recovery: 'indexeddb-read-omitted',
        error: currentStateReadError.message,
      } : {}),
    };
  }
  const restoredState = mergeBrowserStorageStates([currentState, ...overlays]);
  if (currentStateReadError) {
    const fallbackState = withoutIndexedDb(restoredState);
    try {
      await retryTransientBrowserOperation(
        () => browserContext.setStorageState(fallbackState),
        { maxAttempts: 3, initialDelayMs: 500 },
      );
      return {
        restoredSystems,
        state: fallbackState,
        degraded: true,
        recovery: 'indexeddb-omitted',
        error: currentStateReadError.message,
      };
    } catch (fallbackError) {
      if (isClosedBrowserStorageRestoreError(fallbackError)) throw fallbackError;
      return {
        restoredSystems: [],
        attemptedSystems: restoredSystems,
        state: currentState,
        degraded: true,
        recovery: 'persistent-profile-retained',
        error: fallbackError.message,
      };
    }
  }
  try {
    await retryTransientBrowserOperation(
      () => browserContext.setStorageState(restoredState),
      { maxAttempts: 4, initialDelayMs: 250 },
    );
    return { restoredSystems, state: restoredState, degraded: false };
  } catch (error) {
    if (isClosedBrowserStorageRestoreError(error) || !isRecoverableStorageRestoreError(error)) throw error;
    const fallbackState = withoutIndexedDb(restoredState);
    try {
      await retryTransientBrowserOperation(
        () => browserContext.setStorageState(fallbackState),
        { maxAttempts: 3, initialDelayMs: 500 },
      );
      return {
        restoredSystems,
        state: fallbackState,
        degraded: true,
        recovery: 'indexeddb-omitted',
        error: error.message,
      };
    } catch (fallbackError) {
      if (isClosedBrowserStorageRestoreError(fallbackError)) throw fallbackError;
      return {
        restoredSystems: [],
        attemptedSystems: restoredSystems,
        state: currentState,
        degraded: true,
        recovery: 'persistent-profile-retained',
        error: fallbackError.message,
      };
    }
  }
};
