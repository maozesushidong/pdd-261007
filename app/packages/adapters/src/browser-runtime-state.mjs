const safePageUrl = (page) => {
  if (!page || page.isClosed?.()) return '';
  try {
    return String(page.url?.() || '');
  } catch {
    return '';
  }
};

export const installManagedPageTitle = ({ prefix, fallbackTitle = 'Business page' } = {}) => {
  const normalizedPrefix = String(prefix || '').trim();
  if (!normalizedPrefix) return false;
  const prefixPattern = /^\u3010PDD\u5e97\u94fa\uff1a.*?\u3011\s*/u;
  const previousPrefix = String(window.__pddManagedTitlePrefix || '').trim();
  const prefixHistory = Array.isArray(window.__pddManagedTitlePrefixes)
    ? window.__pddManagedTitlePrefixes.filter(Boolean)
    : [];
  for (const candidate of [previousPrefix, normalizedPrefix]) {
    if (candidate && !prefixHistory.includes(candidate)) prefixHistory.push(candidate);
  }
  window.__pddManagedTitlePrefixes = prefixHistory.slice(-8);
  window.__pddManagedTitlePrefix = normalizedPrefix;
  window.__pddManagedTitleFallback = String(fallbackTitle || 'Business page');
  const applyTitle = () => {
    const currentPrefix = String(window.__pddManagedTitlePrefix || '').trim();
    if (!currentPrefix) return;
    let baseTitle = String(document.title || '');
    for (const managedPrefix of window.__pddManagedTitlePrefixes || []) {
      if (baseTitle.startsWith(managedPrefix)) baseTitle = baseTitle.slice(managedPrefix.length).trim();
    }
    baseTitle = baseTitle.replace(prefixPattern, '').trim();
    const nextTitle = `${currentPrefix} ${baseTitle || window.__pddManagedTitleFallback}`;
    if (document.title !== nextTitle) document.title = nextTitle;
  };
  if (!window.__pddManagedTitleObserver) {
    window.__pddManagedTitleObserver = new MutationObserver(applyTitle);
    window.__pddManagedTitleObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }
  applyTitle();
  return true;
};

export const isPddLoginUrl = (value) => {
  try {
    const url = new URL(String(value || ''));
    return url.hostname === 'mms.pinduoduo.com' && /^\/login(?:\/|$)/u.test(url.pathname);
  } catch {
    return false;
  }
};

export const isBrowserNetworkErrorUrl = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith('chrome-error:')
    || normalized.startsWith('edge-error:')
    || normalized === 'about:neterror'
    || normalized.startsWith('about:neterror?')
    || normalized.startsWith('about:neterror#');
};

export const isAuthenticatedPddUrl = (value) => {
  try {
    const url = new URL(String(value || ''));
    return url.hostname === 'mms.pinduoduo.com' && !isPddLoginUrl(url.href);
  } catch {
    return false;
  }
};

export const isSystemLoginUrl = (system, value) => {
  if (system === 'pdd') return isPddLoginUrl(value);
  try {
    const url = new URL(String(value || ''));
    if (system === 'oms') {
      return url.hostname === 'www.jeoms.com' && url.pathname.startsWith('/xianma/login');
    }
    if (system === 'tms') {
      return url.hostname === 'tms.aipro123.top' && /^\/login(?:\/|$)/u.test(url.pathname);
    }
    return false;
  } catch {
    return false;
  }
};

export const isAuthenticatedSystemUrl = (system, value) => {
  if (system === 'pdd') return isAuthenticatedPddUrl(value);
  try {
    const url = new URL(String(value || ''));
    const expectedHost = system === 'oms' ? 'www.jeoms.com'
      : system === 'tms' ? 'tms.aipro123.top' : null;
    return Boolean(expectedHost && url.hostname === expectedHost && !isSystemLoginUrl(system, url.href));
  } catch {
    return false;
  }
};

const pddPageScore = (value) => {
  if (!isAuthenticatedPddUrl(value)) return isPddLoginUrl(value) ? 10 : 0;
  const url = new URL(value);
  if (url.pathname === '/aftersales/work_order/list') return 500;
  if (url.pathname.includes('/aftersales/work_order/')) return 400;
  if (url.pathname.includes('/aftersales')) return 300;
  return 200;
};

export const selectLivePddPage = (pages, currentPage = null) => {
  let selected = null;
  let selectedScore = -1;
  for (const page of pages || []) {
    const score = pddPageScore(safePageUrl(page)) + (page === currentPage ? 1 : 0);
    if (score <= 0 || score <= selectedScore) continue;
    selected = page;
    selectedScore = score;
  }
  return selected || currentPage || null;
};

export const selectLiveSystemPage = (system, pages, currentPage = null) => {
  if (system === 'pdd') return selectLivePddPage(pages, currentPage);
  let selected = null;
  let selectedScore = -1;
  for (const page of pages || []) {
    const url = safePageUrl(page);
    const baseScore = isAuthenticatedSystemUrl(system, url) ? 200
      : isSystemLoginUrl(system, url) ? 10 : 0;
    const score = baseScore + (page === currentPage ? 1 : 0);
    if (score <= 0 || score <= selectedScore) continue;
    selected = page;
    selectedScore = score;
  }
  return selected || currentPage || null;
};

export const decideBrowserProbeFailure = ({
  connected,
  pageCount,
  failureCount,
  failureLimit,
  error,
} = {}) => {
  const message = String(error?.message || error || '');
  const numericPageCount = Number(pageCount);
  const definitivelyUnavailable = connected === false
    || (Number.isFinite(numericPageCount) && numericPageCount < 1)
    || /connection is closed|browser has been closed|browser process.*exited|chromium connection is closed/iu.test(message);
  const normalizedFailureCount = Math.max(0, Number(failureCount) || 0);
  const normalizedFailureLimit = Math.max(2, Number(failureLimit) || 2);
  return {
    definitivelyUnavailable,
    restart: definitivelyUnavailable || normalizedFailureCount >= normalizedFailureLimit,
    failureCount: normalizedFailureCount,
    failureLimit: normalizedFailureLimit,
  };
};
