const popupRedirectStateKey = '__pddAgentPopupRedirectState';

const installSameTabPopupRedirect = async (action) => action.evaluate((element, stateKey) => {
  const token = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const existing = window[stateKey];
  const originalOpen = existing?.originalOpen || window.open;
  const anchor = element.matches?.('a[href]')
    ? element
    : element.closest?.('a[href]') || element.querySelector?.('a[href]');
  const originalTarget = anchor?.getAttribute('target') ?? null;

  if (anchor) anchor.setAttribute('target', '_self');
  window[stateKey] = {
    token,
    originalOpen,
    anchor,
    originalTarget,
  };
  window.open = (url) => {
    const targetUrl = String(url || '').trim();
    if (targetUrl && targetUrl !== 'about:blank') window.location.assign(targetUrl);
    return window;
  };
  return token;
}, popupRedirectStateKey);

const restorePopupBehavior = async (page, token) => page.evaluate(({ stateKey, expectedToken }) => {
  const state = window[stateKey];
  if (!state || state.token !== expectedToken) return;
  window.open = state.originalOpen;
  if (state.anchor?.isConnected) {
    if (state.originalTarget == null) state.anchor.removeAttribute('target');
    else state.anchor.setAttribute('target', state.originalTarget);
  }
  delete window[stateKey];
}, { stateKey: popupRedirectStateKey, expectedToken: token });

export const clickPddActionWithoutForegroundPopup = async (page, action, {
  clickOptions = {},
  forceSameTab = String(process.env.WORKFLOW_FOREGROUND_MODE || 'manual-only')
    .trim().toLowerCase() === 'never',
} = {}) => {
  if (!forceSameTab) return action.click(clickOptions);

  const token = await installSameTabPopupRedirect(action);
  try {
    return await action.click(clickOptions);
  } finally {
    // A successful same-tab navigation destroys the patched document. When
    // the action opens an in-page overlay, restore window.open immediately.
    await restorePopupBehavior(page, token).catch(() => {});
  }
};

// A deep refund scan must keep its list tab and pagination intact while a
// "查看详情" button opens a detail. In never-foreground mode the generic
// helper redirects window.open into the list tab, which forces a full page
// replay after *every* detail on page two or later. Capture the popup target
// from the real click and open it through the caller's background-tab factory.
// Other click behaviors (including an in-page overlay) retain their fallback.
export const clickPddDetailInBackground = async (page, action, {
  createBackgroundPage,
  isAllowedUrl,
  onCapturedTarget = null,
  clickOptions = {},
} = {}) => {
  if (typeof createBackgroundPage !== 'function'
    || typeof isAllowedUrl !== 'function') {
    await clickPddActionWithoutForegroundPopup(page, action, { clickOptions });
    return null;
  }

  const originalUrl = page.url();
  const stateKey = '__pddAgentBackgroundDetailCapture';
  const token = await action.evaluate((element, key) => {
    const state = {
      token: globalThis.crypto?.randomUUID?.()
        || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      originalOpen: window.open,
      urls: [],
      anchor: element.matches?.('a[href]')
        ? element : element.closest?.('a[href]') || element.querySelector?.('a[href]'),
      clickListener: null,
    };
    const record = (value) => {
      const raw = String(value || '').trim();
      if (!raw || raw === 'about:blank') return;
      try { state.urls.push(new URL(raw, document.baseURI).href); } catch { /* invalid URL */ }
    };
    const fakeLocation = {
      set href(value) { record(value); },
      assign: record,
      replace: record,
    };
    window.open = (url) => {
      record(url);
      return {
        closed: false,
        focus() {},
        close() {},
        postMessage() {},
        location: fakeLocation,
      };
    };
    if (state.anchor) {
      state.clickListener = (event) => {
        record(state.anchor.href);
        event.preventDefault();
      };
      state.anchor.addEventListener('click', state.clickListener, { capture: true });
    }
    window[key] = state;
    return state.token;
  }, stateKey);

  let urls = [];
  try {
    await action.click(clickOptions);
    urls = await page.evaluate(({ key, expectedToken }) => {
      const state = window[key];
      return state?.token === expectedToken ? state.urls : [];
    }, { key: stateKey, expectedToken: token }).catch(() => []);
  } finally {
    await page.evaluate(({ key, expectedToken }) => {
      const state = window[key];
      if (!state || state.token !== expectedToken) return;
      window.open = state.originalOpen;
      if (state.anchor?.isConnected && state.clickListener) {
        state.anchor.removeEventListener('click', state.clickListener, { capture: true });
      }
      delete window[key];
    }, { key: stateKey, expectedToken: token }).catch(() => {});
  }

  // A site handler may navigate the current tab directly rather than call
  // window.open. Let the collector's existing same-tab recovery handle it.
  if (page.url() !== originalUrl) return null;
  const capturedUrls = [...new Set(urls)];
  const allowedUrls = capturedUrls.filter((url) => isAllowedUrl(url));
  const targetUrl = allowedUrls[0];
  if (!targetUrl) {
    if (urls.length) {
      const safeTargets = [...new Set(urls)].slice(0, 3).map((raw) => {
        try {
          const target = new URL(raw);
          const path = `${target.origin}${target.pathname}`;
          if (!target.hostname.endsWith('.pinduoduo.com')) return path;
          const id = target.searchParams.get('id');
          const orderSn = target.searchParams.get('orderSn');
          const fields = [
            /^\d{8,18}$/u.test(id || '') ? `id=${id}` : null,
            /^\d{6}-\d{12,}$/u.test(orderSn || '') ? `orderSn=${orderSn}` : null,
          ].filter(Boolean);
          return fields.length ? `${path}?${fields.join('&')}` : path;
        } catch { return 'invalid-url'; }
      });
      const error = new Error(
        `拼多多详情打开了未识别的地址，扫描已暂停以免跳过售后单（目标路径: ${safeTargets.join(', ')}）`,
      );
      error.code = 'PDD_RETURN_REFUND_BACKGROUND_DETAIL_UNRECOGNIZED';
      error.capturedTargets = safeTargets;
      throw error;
    }
    return null;
  }
  // The original click has already happened, but the target has not been
  // navigated. A caller can avoid a redundant detail load only with proof for
  // this exact captured target. Multiple targets are never skipped.
  if (capturedUrls.length === 1 && allowedUrls.length === 1
    && typeof onCapturedTarget === 'function') {
    const disposition = await onCapturedTarget(targetUrl);
    if (disposition?.skip === true) {
      return { skipped: true, targetUrl, disposition };
    }
  }
  const detailPage = await createBackgroundPage();
  try {
    await detailPage.goto(targetUrl, { waitUntil: 'commit', timeout: 45_000 });
    return detailPage;
  } catch (error) {
    await detailPage.close({ runBeforeUnload: false }).catch(() => {});
    throw error;
  }
};
