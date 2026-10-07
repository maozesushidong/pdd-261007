const stalePageMessagePattern = /当前页面停留时间过长[\s\S]*建议刷新一次页面/u;
const exactRefreshButtonPattern = /^\s*刷新\s*$/u;

// PDD occasionally presents this business modal after a detail page has been
// left open. Keep the selectors deliberately narrow: a page can contain other
// refresh controls, and those must never be clicked by recovery code.
const visibleModalSelectors = [
  '[role="dialog"]:visible',
  '[aria-modal="true"]:visible',
  '[data-testid*="modal" i]:visible',
  '[data-testid*="dialog" i]:visible',
  '[class*="modal" i]:visible',
  '[class*="dialog" i]:visible',
].join(', ');

const pageRefreshHandledAt = new WeakMap();

const visibleExactRefreshButton = async (scope) => {
  const candidates = [
    scope.getByRole('button', { name: exactRefreshButtonPattern }),
    scope.locator('button').filter({ hasText: exactRefreshButtonPattern }),
    scope.locator('[role="button"]').filter({ hasText: exactRefreshButtonPattern }),
    scope.locator('a').filter({ hasText: exactRefreshButtonPattern }),
  ];
  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const button = candidate.nth(index);
      if (await button.isVisible().catch(() => false)) return button;
    }
  }
  return null;
};

const findStalePageRefreshScope = async (page) => {
  const modalCandidates = page.locator(visibleModalSelectors);
  const modalCount = Math.min(40, await modalCandidates.count().catch(() => 0));
  for (let index = 0; index < modalCount; index += 1) {
    const modal = modalCandidates.nth(index);
    const text = await modal.innerText({ timeout: 1_000 }).catch(() => '');
    if (!stalePageMessagePattern.test(String(text || '').replace(/\s+/gu, ' '))) continue;
    const button = await visibleExactRefreshButton(modal);
    if (button) return { scope: modal, button };
  }

  // Some PDD builds omit dialog attributes. Start from the distinctive
  // message and climb only to a modal-like ancestor that contains both texts.
  const message = page.getByText(/当前页面停留时间过长/u).first();
  if (!await message.isVisible().catch(() => false)) return null;
  const ancestor = message.locator(
    'xpath=ancestor-or-self::*[@role="dialog" or @aria-modal="true" or contains(translate(@class,"MODALDIALOG","modaldialog"),"modal") or contains(translate(@class,"MODALDIALOG","modaldialog"),"dialog")][1]',
  );
  const ancestorText = await ancestor.innerText({ timeout: 1_000 }).catch(() => '');
  if (stalePageMessagePattern.test(String(ancestorText || '').replace(/\s+/gu, ' '))) {
    const button = await visibleExactRefreshButton(ancestor);
    if (button) return { scope: ancestor, button };
  }

  // A few PDD builds render this same modal as plain nested divs without a
  // dialog role or modal class. Walk only the nearest small ancestors of the
  // distinctive message and require both the full stale-page text and an
  // exact visible "刷新" control in that same container. This cannot select
  // an unrelated page refresh button in the underlying detail view.
  let plainAncestor = message.locator('xpath=..');
  for (let depth = 0; depth < 16; depth += 1) {
    const text = await plainAncestor.innerText({ timeout: 1_000 }).catch(() => '');
    if (stalePageMessagePattern.test(String(text || '').replace(/\s+/gu, ' '))) {
      const plainButton = await visibleExactRefreshButton(plainAncestor);
      if (plainButton) return { scope: plainAncestor, button: plainButton };
    }
    plainAncestor = plainAncestor.locator('xpath=..');
  }

  // Some builds place the message in a deeply nested React portal without a
  // modal role/class. Walk outward from each exact refresh control as a final
  // scoped fallback. This still cannot click an unrelated page refresh: the
  // same ancestor must contain the full stale-page message.
  const refreshControls = page.locator([
    'button',
    '[role="button"]',
    'a',
  ].join(', ')).filter({ hasText: exactRefreshButtonPattern });
  const refreshCount = Math.min(80, await refreshControls.count().catch(() => 0));
  for (let index = 0; index < refreshCount; index += 1) {
    const button = refreshControls.nth(index);
    if (!await button.isVisible().catch(() => false)) continue;
    let scope = button;
    for (let depth = 0; depth < 16; depth += 1) {
      const text = await scope.innerText({ timeout: 1_000 }).catch(() => '');
      if (stalePageMessagePattern.test(String(text || '').replace(/\s+/gu, ' '))) {
        return { scope, button };
      }
      scope = scope.locator('xpath=..');
    }
  }
  return null;
};

/**
 * Click the refresh action inside PDD's stale-page modal.
 *
 * This is intentionally not a generic page reload and never searches the
 * whole document for a button named "刷新". The caller can safely invoke it
 * before normal page actions; a short per-page cooldown prevents duplicate
 * clicks while the modal is being removed and the detail view is rerendered.
 */
export const clickVisiblePddStalePageRefresh = async (
  page,
  { cooldownMs = 3_000, settleMs = 600 } = {},
) => {
  if (!page || page.isClosed()) return { handled: false, reason: 'page-closed' };
  const previous = pageRefreshHandledAt.get(page) || 0;
  if (Date.now() - previous < Math.max(0, cooldownMs)) {
    return { handled: false, reason: 'cooldown' };
  }

  const located = await findStalePageRefreshScope(page);
  if (!located) return { handled: false, reason: 'modal-not-found' };

  const beforeUrl = page.url();
  try {
    await located.button.click({ timeout: 5_000 });
  } catch (error) {
    return { handled: false, reason: 'click-failed', error: error.message };
  }
  pageRefreshHandledAt.set(page, Date.now());

  // The button may navigate or only trigger an in-place request. Wait for
  // either case to settle without imposing an unbounded delay on the worker.
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(Math.max(0, settleMs)).catch(() => {});
  return {
    handled: true,
    action: 'click-stale-page-refresh',
    beforeUrl,
    afterUrl: page.isClosed() ? null : page.url(),
    handledAt: new Date().toISOString(),
  };
};

export const __stalePageRefreshTest = {
  stalePageMessagePattern,
  visibleModalSelectors,
};
