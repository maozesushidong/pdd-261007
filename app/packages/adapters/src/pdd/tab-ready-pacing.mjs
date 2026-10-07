// One readiness/pacing gate per new PDD page, shared by observers and actions.
// Navigation itself must remain available so about:blank can reach PDD first.
export const createPddTabReadyPacing = ({
  loadSettleMs = 1000,
  actionStartMs = 1000,
  loadTimeoutMs = 30_000,
} = {}) => {
  const pages = new WeakMap();
  const isPdd = page => page && !page.isClosed()
    && String(page.url()).startsWith('https://mms.pinduoduo.com/');
  const prepare = async page => {
    if (!isPdd(page)) return false;
    const previous = pages.get(page);
    if (previous?.ready) return false;
    if (previous?.pending) { await previous.pending; return true; }
    const state = { ready: false, pending: null };
    pages.set(page, state);
    state.pending = (async () => {
      await page.waitForLoadState('domcontentloaded', { timeout: loadTimeoutMs });
      if (!isPdd(page)) return;
      if (loadSettleMs > 0) await page.waitForTimeout(loadSettleMs);
      if (actionStartMs > 0) await page.waitForTimeout(actionStartMs);
      if (page.isClosed()) throw new Error('PDD tab closed before automation started');
      state.ready = true;
    })();
    try { await state.pending; return true; }
    finally { state.pending = null; if (!state.ready) pages.delete(page); }
  };
  const beforeOperation = async (page, operation) => {
    if (/\.(?:goto|reload|goBack|goForward|setContent|close)$/u.test(operation)) return;
    await prepare(page);
  };
  return { prepare, beforeOperation };
};
