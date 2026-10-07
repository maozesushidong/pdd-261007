const clickRenderedControl = async (locator) => locator.evaluate((node) => {
  const control = node.closest?.('button, [role="button"], a') || node;
  if (!(control instanceof HTMLElement)) return false;
  if (control.matches(':disabled, [aria-disabled="true"]')) return false;
  const style = window.getComputedStyle(control);
  const rect = control.getBoundingClientRect();
  if (style.display === 'none'
    || style.visibility === 'hidden'
    || Number(style.opacity) === 0
    || rect.width <= 0
    || rect.height <= 0
    || control.getClientRects().length === 0) return false;
  control.click();
  return true;
}).catch(() => false);

export const clickFirstLivePddQrRefreshCandidate = async (
  candidateGroups,
  { maxAttempts = 3, retryDelayMs = 120, waitForTimeout = async () => {} } = {},
) => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    for (const candidate of candidateGroups) {
      const count = await candidate.count().catch(() => 0);
      for (let index = 0; index < count; index++) {
        if (await clickRenderedControl(candidate.nth(index))) return true;
      }
    }
    if (attempt + 1 < maxAttempts) await waitForTimeout(retryDelayMs);
  }
  return false;
};

export const clickVisiblePddQrRefreshControl = async (page, options = {}) => (
  clickFirstLivePddQrRefreshCandidate([
    page.getByRole('button', { name: '点击刷新', exact: true }),
    page.getByRole('button', { name: /刷新二维码|重新获取/ }),
    page.locator('button, [role="button"], a').filter({
      hasText: /点击刷新|刷新二维码|重新获取/,
    }),
  ], {
    ...options,
    waitForTimeout: (delayMs) => page.waitForTimeout(delayMs),
  })
);
