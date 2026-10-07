import { detectHumanVerification } from '../verification-detector/detect.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const shouldFallbackFromPddOrderRemarkVerification = ({
  remark = {},
  verificationStage = null,
  orderNumber,
  maxChallenges = 1,
} = {}) => {
  const expectedOrderNumber = String(orderNumber || '').trim();
  if (!expectedOrderNumber || remark?.status === 'saved') return false;
  const remarkOrderNumber = String(remark?.orderNumber || '').trim();
  if (remarkOrderNumber && remarkOrderNumber !== expectedOrderNumber) return false;
  const observedChallenges = Math.max(
    0,
    Number.isFinite(Number(remark?.verificationChallenges))
      ? Math.floor(Number(remark.verificationChallenges))
      : 0,
    String(verificationStage || '').startsWith('pdd-order-remark') ? 1 : 0,
  );
  return observedChallenges >= Math.max(1, Math.floor(Number(maxChallenges) || 1));
};

const pddOrderRemarkFatalError = (result) => {
  const loginRequired = result?.fatal === 'login';
  const error = new Error(
    `拼多多订单详情进入${loginRequired ? '登录页' : '验证页面'}，不能跳过备注`,
  );
  if (loginRequired) {
    error.code = 'PDD_SESSION_EXPIRED';
    error.externalEffectStatus = 'failed';
    error.pddSessionExpiry = {
      source: 'pdd-order-remark-detail',
      url: result?.url || null,
    };
  }
  return error;
};

const visibleElement = async (locator) => {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index++) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
};

const isObservedReloadInterruption = (error) => {
  const message = String(error?.message || error || '');
  return /page\.reload: Timeout \d+ms exceeded/u.test(message)
    || /page\.reload: net::ERR_ABORTED(?:; maybe frame was detached)?/iu.test(message);
};

const firstVisible = async (locators) => {
  for (const locator of locators) {
    const candidate = await visibleElement(locator);
    if (candidate) return candidate;
  }
  return null;
};

const readText = (scope) => scope.locator('body').innerText().catch(() => '');

const isLoginSurface = (url, text) => /\/login(?:[/?#]|$)/i.test(String(url || ''))
  || /(?:扫码登录|账号登录|请输入账号名|登录拼多多)/.test(text);

const isVerificationSurface = (text) => /(?:安全验证|滑动验证|完成拼图|短信验证码|请输入验证码)/.test(text);

const hasDetailIndicators = (text) => /(?:订单详情|订单编号|订单信息|商品信息|收货信息|添加备注|修改备注)/.test(text);
const hasRemarkSurface = (text) => /(?:订单备注|(?:添加|修改)\s*备注)/.test(text);
const safePopupTextPattern = /(?:新手引导|功能介绍|操作指引|我知道了|暂不查看)/;
const protectedPopupTextPattern = /(?:安全验证|验证码|滑块|拼图|退款|提交|确认|备注|拦截|处理结果|登录)/;
const marketingMenuTextPattern = /(?:跨境电商|TEMU|网格仓|服务站招募)/i;

export const isDismissiblePddMarketingBlocker = (blocker) => {
  const className = String(blocker?.className || '');
  const text = String(blocker?.text || '');
  return /(?:^|\s)mms-header__open-item(?:\s|$)/.test(className)
    && marketingMenuTextPattern.test(text)
    && !protectedPopupTextPattern.test(text);
};

// PDD sometimes renders a product-name tooltip in a portal above the order
// detail action. It is not a business dialog and can safely be dismissed;
// leaving it in place would incorrectly send an otherwise actionable order
// to manual review.
const isDismissiblePddProductTooltip = (blocker) => {
  const testId = String(blocker?.testId || '');
  const className = String(blocker?.className || '');
  const text = String(blocker?.text || '').trim();
  return testId === 'beast-core-portal-main'
    && /(?:portalMain|tooltipMain)/i.test(className)
    && text.length > 0
    && text.length <= 300
    && !protectedPopupTextPattern.test(text);
};

const dismissPddMarketingBlocker = async ({ targetPage, blocker, action }) => {
  const isMarketingMenu = isDismissiblePddMarketingBlocker(blocker);
  const isProductTooltip = isDismissiblePddProductTooltip(blocker);
  if (!isMarketingMenu && !isProductTooltip) return false;
  await action(
    isProductTooltip ? 'dismiss-pdd-product-tooltip' : 'dismiss-pdd-header-marketing-menu',
    async () => {
    await targetPage.keyboard.press('Escape').catch(() => {});
    const viewport = targetPage.viewportSize() || { width: 1280, height: 720 };
    await targetPage.mouse.move(
      Math.max(1, viewport.width - 2),
      Math.max(1, viewport.height - 2),
    ).catch(() => {});
    },
  );
  await sleep(150);
  return true;
};

const isPddOrderDetailUrl = (value) => {
  try {
    return /\/orders\/detail(?:\/|$)/i.test(new URL(String(value || '')).pathname);
  } catch {
    return false;
  }
};

const closeStaleOrderDetailPages = async (context, sourcePage) => {
  for (const page of context.pages()) {
    if (page === sourcePage || page.isClosed() || !isPddOrderDetailUrl(page.url())) continue;
    await page.close({ runBeforeUnload: false }).catch(() => {});
  }
};

const dismissSafePddPopups = async ({ targetPage, action }) => {
  const containers = targetPage.locator([
    '[data-testid="beast-core-modal"]',
    '[role="dialog"]',
    '[class*="tour" i]',
    '[class*="guide" i]',
    '[class*="onboarding" i]',
  ].join(','));
  let dismissed = 0;
  const count = await containers.count().catch(() => 0);
  for (let index = 0; index < count; index++) {
    const container = containers.nth(index);
    if (!await container.isVisible().catch(() => false)) continue;
    const metadata = await container.evaluate((element) => ({
      text: String(element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      className: String(element.className || ''),
      testId: element.getAttribute('data-testid') || '',
    })).catch(() => ({ text: '', className: '', testId: '' }));
    const safeStructure = /(?:tour|guide|onboarding)/i.test(`${metadata.className} ${metadata.testId}`);
    if (protectedPopupTextPattern.test(metadata.text)
      || (!safeStructure && !safePopupTextPattern.test(metadata.text))) continue;
    const close = await firstVisible([
      container.getByTestId('beast-core-modal-close-button'),
      container.locator('[aria-label*="关闭"], [title*="关闭"], button[class*="close" i]'),
      container.getByRole('button', { name: /^(?:关闭|我知道了|暂不查看)$/ }),
    ]);
    if (!close) continue;
    await action('close-safe-pdd-popup', () => close.click({ force: true }));
    dismissed++;
    await sleep(250);
  }
  return dismissed;
};

const describeActionBlocker = async (target) => {
  await target.evaluate((element) => new Promise((resolve) => {
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })).catch(() => target.scrollIntoViewIfNeeded().catch(() => {}));
  return target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const top = document.elementFromPoint(x, y);
    if (!top || element.contains(top) || top.contains(element)) return null;
    const blocker = top.closest([
      '[data-testid="beast-core-modal"]',
      '[data-testid="beast-core-modal-container"]',
      '[role="dialog"]',
      '[class*="modal" i]',
      '[class*="overlay" i]',
      '[class~="mms-header__open-item"]',
    ].join(',')) || top;
    return {
      tagName: blocker.tagName.toLowerCase(),
      testId: blocker.getAttribute('data-testid') || null,
      className: String(blocker.className || '').slice(0, 200) || null,
      text: String(blocker.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null,
    };
  }).catch(() => null);
};

const findOrderInfoDetailAction = async (page) => {
  const headings = page.locator('xpath=//*[normalize-space(text())="订单信息"]');
  const visibleHeadings = [];
  const count = await headings.count().catch(() => 0);
  for (let index = 0; index < count; index++) {
    const heading = headings.nth(index);
    if (!await heading.isVisible().catch(() => false)) continue;
    const box = await heading.boundingBox().catch(() => null);
    visibleHeadings.push({ heading, x: box?.x ?? 0 });
  }
  visibleHeadings.sort((left, right) => right.x - left.x);
  for (const { heading } of visibleHeadings) {
    const sameRowDetail = await firstVisible([
      heading.locator('xpath=following-sibling::*[normalize-space(.)="查看详情"][1]'),
      heading.locator('xpath=following-sibling::*[1]//*[normalize-space(.)="查看详情"]'),
      heading.locator('xpath=../*[normalize-space(.)="查看详情"]'),
    ]);
    if (sameRowDetail) return sameRowDetail;
    let container = heading;
    for (let depth = 0; depth < 7; depth++) {
      container = container.locator('xpath=..');
      const detail = await visibleElement(container.getByText('查看详情', { exact: true }));
      if (detail) return detail;
    }
  }
  return null;
};

const visibleDetailContainers = async (page) => {
  const selector = [
    '[role="dialog"]',
    '[class*="drawer" i]',
    '[class*="modal" i]',
    '[class*="popup" i]',
  ].join(',');
  const containers = page.locator(selector);
  const result = [];
  const count = await containers.count().catch(() => 0);
  for (let index = 0; index < count; index++) {
    const container = containers.nth(index);
    if (await container.isVisible().catch(() => false)) result.push(container);
  }
  return result;
};

const inspectDetailCandidate = async ({
  scope,
  page,
  mode,
  orderNumber,
  initialText,
  initialUrl,
  ignoreVerification = false,
}) => {
  const text = scope === page ? await readText(page) : await scope.innerText().catch(() => '');
  const url = page.url();
  if (isLoginSurface(url, text)) return { fatal: 'login', url };
  if (!ignoreVerification && isVerificationSurface(text)) return { fatal: 'verification', url };
  const rendered = hasDetailIndicators(text);
  const matchesOrder = text.includes(orderNumber);
  const changed = mode !== 'current-page'
    || (hasRemarkSurface(text) && (url !== initialUrl || text !== initialText));
  if (rendered && matchesOrder && changed) return { scope, page, mode, text, url };
  if (rendered && changed && /\b\d{16,24}\b/.test(text) && !matchesOrder) {
    return { wrongOrder: true, mode, url };
  }
  return null;
};

const waitForRenderedOrderDetail = async ({
  sourcePage,
  initialPages,
  trackedPages,
  orderNumber,
  initialText,
  initialUrl,
  timeoutMs,
  pollMs,
  reopenAfterMs,
  onVerification,
}) => {
  let deadline = Date.now() + timeoutMs;
  const reopenAt = Date.now() + reopenAfterMs;
  let wrongOrder = null;
  let sourceVerificationRecoveredAt = null;
  const inspectWithVerificationRecovery = async (options) => {
    if (typeof onVerification === 'function' && await detectHumanVerification(options.page)) {
      const recovered = await onVerification(options.page);
      if (recovered) return { verificationRecovered: true, page: options.page };
    }
    const result = await inspectDetailCandidate(options);
    if (result?.fatal !== 'verification' || typeof onVerification !== 'function') return result;
    const recovered = await onVerification(options.page);
    if (recovered) return { verificationRecovered: true, page: options.page };
    return inspectDetailCandidate({ ...options, ignoreVerification: true });
  };
  while (Date.now() < deadline) {
    for (const page of sourcePage.context().pages()) {
      if (!initialPages.has(page)) trackedPages.add(page);
    }
    const pages = [...new Set([...trackedPages, sourcePage])]
      .filter((page) => !page.isClosed());
    for (const page of pages) {
      for (const container of await visibleDetailContainers(page)) {
        const result = await inspectWithVerificationRecovery({
          scope: container,
          page,
          mode: /drawer/i.test(await container.getAttribute('class').catch(() => '')) ? 'drawer' : 'modal',
          orderNumber,
          initialText,
          initialUrl,
        });
        if (result?.verificationRecovered) {
          if (result.page === sourcePage) sourceVerificationRecoveredAt = Date.now();
          deadline = Date.now() + timeoutMs;
          continue;
        }
        if (result?.fatal) throw pddOrderRemarkFatalError(result);
        if (result?.wrongOrder) wrongOrder = result;
        if (result?.scope) return result;
      }
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        const result = await inspectWithVerificationRecovery({
          scope: frame.locator('body'),
          page,
          mode: 'iframe',
          orderNumber,
          initialText,
          initialUrl,
        });
        if (result?.verificationRecovered) {
          if (result.page === sourcePage) sourceVerificationRecoveredAt = Date.now();
          deadline = Date.now() + timeoutMs;
          continue;
        }
        if (result?.fatal) throw pddOrderRemarkFatalError(result);
        if (result?.wrongOrder) wrongOrder = result;
        if (result?.scope) return result;
      }
      const result = await inspectWithVerificationRecovery({
        scope: page,
        page,
        mode: page === sourcePage ? 'current-page' : 'popup',
        orderNumber,
        initialText,
        initialUrl,
      });
      if (result?.verificationRecovered) {
        if (result.page === sourcePage) sourceVerificationRecoveredAt = Date.now();
        deadline = Date.now() + timeoutMs;
        continue;
      }
      if (result?.fatal) throw pddOrderRemarkFatalError(result);
      if (result?.wrongOrder) wrongOrder = result;
      if (result?.scope) return result;
    }
    const sourceActionVisible = Boolean(await findOrderInfoDetailAction(sourcePage));
    const recoveredSourceReadyToReopen = sourceVerificationRecoveredAt
      && Date.now() - sourceVerificationRecoveredAt >= Math.max(500, pollMs * 2);
    if (sourceActionVisible && (recoveredSourceReadyToReopen || Date.now() >= reopenAt)) {
      return { reopenRequired: true };
    }
    await sleep(pollMs);
  }
  if (wrongOrder) throw new Error('拼多多订单详情的订单号与当前工单不一致');
  throw new Error('拼多多订单详情未在限定时间内完成渲染');
};

const remarkEntryPattern = /(?:添加|修改)\s*备注/;

const findRemarkEntry = async (scope) => {
  const entry = await firstVisible([
    scope.getByRole('button', { name: remarkEntryPattern }),
    scope.getByRole('link', { name: remarkEntryPattern }),
    scope.locator('[role="button"]').filter({ hasText: remarkEntryPattern }),
    scope.locator('button, a').filter({ hasText: remarkEntryPattern }),
    scope.getByText(remarkEntryPattern),
  ]);
  if (entry) return entry;

  const labels = scope.getByText(/订单备注/);
  const count = await labels.count().catch(() => 0);
  for (let index = 0; index < count; index++) {
    const label = labels.nth(index);
    if (!await label.isVisible().catch(() => false)) continue;
    let container = label;
    for (let depth = 0; depth < 5; depth++) {
      container = container.locator('xpath=..');
      const nearbyEntry = await firstVisible([
        container.getByRole('button', { name: remarkEntryPattern }),
        container.getByRole('link', { name: remarkEntryPattern }),
        container.locator('[role="button"], button, a').filter({ hasText: remarkEntryPattern }),
      ]);
      if (nearbyEntry) return nearbyEntry;
    }
  }
  return null;
};

const waitForRemarkEntry = async ({ scope, timeoutMs, pollMs }) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = await findRemarkEntry(scope);
    if (entry) return entry;
    await sleep(pollMs);
  }
  return null;
};

const waitForOrderInfoDetailAction = async ({
  page,
  timeoutMs,
  pollMs,
  onVerification,
}) => {
  let deadline = Date.now() + timeoutMs;
  do {
    const verificationStartedAt = Date.now();
    if (typeof onVerification === 'function' && await detectHumanVerification(page)) {
      await onVerification(page);
    }
    deadline += Math.max(0, Date.now() - verificationStartedAt);
    const action = await findOrderInfoDetailAction(page);
    if (action) return action;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(Math.max(1, pollMs), remainingMs));
  } while (Date.now() < deadline);
  return null;
};

const waitForActionableRemarkEntry = async ({ scope, page, timeoutMs, pollMs, onVerification }) => {
  let deadline = Date.now() + timeoutMs;
  let disabledSeen = false;
  while (Date.now() < deadline) {
    if (typeof onVerification === 'function' && await detectHumanVerification(page)) {
      const verificationStartedAt = Date.now();
      await onVerification(page);
      deadline += Math.max(0, Date.now() - verificationStartedAt);
    }
    const entry = await findRemarkEntry(scope);
    if (entry) {
      if (await entry.isEnabled().catch(() => true)) return { entry, disabledSeen };
      disabledSeen = true;
    }
    await sleep(pollMs);
  }
  return { entry: null, disabledSeen };
};

const hasVisibleRemarkText = async (scope, remarkText) => Boolean(
  await visibleElement(scope.getByText(remarkText, { exact: true })),
);

const transientRemarkEntryError = () => {
  const error = new Error(
    'PDD_ORDER_REMARK_TEMPORARILY_UNAVAILABLE: 拼多多订单备注入口持续处于禁用状态，等待页面恢复后重试',
  );
  error.code = 'PDD_ORDER_REMARK_TEMPORARILY_UNAVAILABLE';
  return error;
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const findRemarkColorOption = async (scope, colorLabel) => firstVisible([
  scope.getByRole('button', { name: new RegExp(`^\\s*${escapeRegex(colorLabel)}`) }),
  scope.getByRole('radio', { name: new RegExp(`^\\s*${escapeRegex(colorLabel)}\\s*$`) }),
  scope.locator('label').filter({ hasText: new RegExp(`^\\s*${escapeRegex(colorLabel)}\\s*$`) }),
  scope.getByText(colorLabel, { exact: true }),
]);

const isRemarkColorSelected = (option, colorLabel) => option.evaluate((element, expectedLabel) => {
  const control = element.closest('button, label, [role="radio"], [role="option"]') || element;
  const selectedAttribute = (candidate) => [
    candidate.getAttribute('aria-checked'),
    candidate.getAttribute('aria-selected'),
    candidate.getAttribute('data-checked'),
    candidate.getAttribute('data-selected'),
    candidate.getAttribute('data-active'),
    candidate.getAttribute('data-state'),
  ].some((value) => /^(?:true|checked|selected|active|on)$/iu.test(String(value || '').trim()));
  for (let current = control, depth = 0; current && depth < 4; current = current.parentElement, depth++) {
    if (selectedAttribute(current)
      || current.matches('input:checked')
      || Boolean(current.querySelector('input:checked, [aria-checked="true"], [aria-selected="true"], [data-checked="true"], [data-selected="true"], [data-state="checked"], [data-state="selected"]'))
      || /(?:^|[-_\s])(?:is[-_])?(?:active|checked|selected)(?:$|[-_\s])/iu.test(String(current.className || ''))) {
      return true;
    }
  }
  const dialog = element.closest('[role="dialog"], [class*="modal" i], [class*="drawer" i]') || document.body;
  return [...dialog.querySelectorAll('*')].some((candidate) => {
    if (control.contains(candidate) || candidate.children.length) return false;
    if (String(candidate.textContent || '').trim() !== expectedLabel) return false;
    const style = getComputedStyle(candidate);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}, colorLabel).catch(() => false);

const transientRemarkColorSelectionError = (colorLabel) => {
  const error = new Error(
    `PDD_ORDER_REMARK_TEMPORARILY_UNAVAILABLE: 拼多多备注${colorLabel}标记选择后未保持选中，等待弹窗重新渲染后自动重试`,
  );
  error.code = 'PDD_ORDER_REMARK_TEMPORARILY_UNAVAILABLE';
  return error;
};

const selectRemarkColor = async ({
  scope,
  colorLabel,
  action,
  settleMs,
  pollMs,
  maxAttempts = 3,
}) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const option = await findRemarkColorOption(scope, colorLabel);
    if (!option) {
      if (attempt === 1) throw new Error(`拼多多备注弹窗未找到${colorLabel}标记`);
      break;
    }
    if (await isRemarkColorSelected(option, colorLabel)) return option;

    await action(
      attempt === 1 ? 'select-order-remark-color' : `select-order-remark-color-retry-${attempt}`,
      () => option.click({ force: true }),
    );
    const deadline = Date.now() + Math.max(1000, settleMs * 2);
    do {
      const refreshedOption = await findRemarkColorOption(scope, colorLabel);
      if (refreshedOption && await isRemarkColorSelected(refreshedOption, colorLabel)) {
        return refreshedOption;
      }
      await sleep(pollMs);
    } while (Date.now() < deadline);
  }
  throw transientRemarkColorSelectionError(colorLabel);
};

const dismissRemarkEditor = async ({ input, scope, page, action, settleMs }) => {
  if (!await input.isVisible().catch(() => false)) return;
  const close = await firstVisible([
    scope.getByRole('button', { name: /^(?:取消|关闭)$/ }),
    scope.locator('[aria-label*="关闭"], [title*="关闭"], button[class*="close" i]'),
  ]);
  if (close) await action('close-order-remark', () => close.click({ force: true }));
  else await page.keyboard.press('Escape').catch(() => {});
  await input.waitFor({ state: 'hidden', timeout: Math.max(1000, settleMs * 2) }).catch(() => {});
};

const returnToWorkOrder = async ({ sourcePage, detail, originalUrl, action }) => {
  if (detail.page !== sourcePage) {
    await detail.page.close().catch(() => {});
    return;
  }
  if (sourcePage.url() !== originalUrl) {
    await action('return-to-work-order-detail', () => sourcePage.goto(originalUrl, { waitUntil: 'domcontentloaded' }));
    return;
  }
  if (['drawer', 'modal', 'iframe'].includes(detail.mode)) {
    const close = await firstVisible([
      detail.scope.getByRole('button', { name: /^(?:关闭|返回)$/ }),
      detail.scope.locator('[aria-label*="关闭"], [title*="关闭"], button[class*="close" i]'),
      sourcePage.getByRole('button', { name: /^(?:关闭|返回)$/ }),
      sourcePage.locator('[aria-label*="关闭"], [title*="关闭"], button[class*="close" i]'),
    ]);
    if (close) await action('close-order-detail', () => close.click({ force: true }));
    else await sourcePage.keyboard.press('Escape').catch(() => {});
  }
};

const openRenderedOrderDetail = async ({
  targetPage,
  orderNumber,
  action,
  timeoutMs,
  popupTimeoutMs,
  pollMs,
  onVerification,
  onDetailFailure,
  maxOpenAttempts = 3,
}) => {
  const originalUrl = targetPage.url();
  const context = targetPage.context();
  await closeStaleOrderDetailPages(context, targetPage);
  const initialPages = new Set(context.pages());
  const trackedPages = new Set();
  let lastError = null;
  const cleanupTrackedPages = async (preservePage = null) => {
    for (const page of [...trackedPages]) {
      if (page === preservePage && !page.isClosed()) continue;
      if (!page.isClosed()) await page.close({ runBeforeUnload: false }).catch(() => {});
      trackedPages.delete(page);
    }
  };
  const recoverHumanVerification = async () => {
    if (typeof onVerification !== 'function') return false;
    await sleep(Math.max(100, Math.min(500, pollMs)));
    if (!await detectHumanVerification(targetPage)) return false;
    await onVerification(targetPage);
    return true;
  };
  try {
    for (let attempt = 1; attempt <= maxOpenAttempts; attempt++) {
      await closeStaleOrderDetailPages(context, targetPage);
      if (typeof onVerification === 'function' && await detectHumanVerification(targetPage)) {
        await onVerification(targetPage);
      }
      const dismissed = await dismissSafePddPopups({ targetPage, action });
      if (dismissed) console.log(`已关闭 ${dismissed} 个拼多多无关提示弹窗。`);
      if (typeof onVerification === 'function' && await detectHumanVerification(targetPage)) {
        await onVerification(targetPage);
      }
      const attemptUrl = targetPage.url();
      const initialText = await readText(targetPage);
      const detailAction = await waitForOrderInfoDetailAction({
        page: targetPage,
        timeoutMs,
        pollMs,
        onVerification,
      });
      if (!detailAction) {
        lastError = new Error('拼多多订单信息区域未找到查看详情');
        throw lastError;
      }
      let blocker = await describeActionBlocker(detailAction);
      if (blocker && await dismissPddMarketingBlocker({ targetPage, blocker, action })) {
        blocker = await describeActionBlocker(detailAction);
      }
      if (blocker) {
        if (await recoverHumanVerification()) continue;
        await onDetailFailure(targetPage, 'pdd-order-remark-blocking-overlay', blocker).catch(() => {});
        throw new Error(`拼多多页面存在未识别的遮挡弹窗，禁止强制点击查看详情: ${JSON.stringify(blocker)}`);
      }

      let popupPromise = Promise.resolve(null);
      try {
        await action('open-order-info-detail', () => {
          popupPromise = targetPage.waitForEvent('popup', {
            timeout: Math.min(timeoutMs, popupTimeoutMs),
          }).catch(() => null);
          return detailAction.click({
            // Popup detection can be short, but the click still needs enough time
            // for PDD's animated drawer and sticky header to settle.
            timeout: Math.min(timeoutMs, Math.max(5_000, popupTimeoutMs)),
          });
        });
      } catch (error) {
        const latePopup = await popupPromise;
        if (latePopup) trackedPages.add(latePopup);
        if (await recoverHumanVerification()) {
          await cleanupTrackedPages();
          continue;
        }
        const clickBlocker = await describeActionBlocker(detailAction);
        if (clickBlocker && await dismissPddMarketingBlocker({
          targetPage,
          blocker: clickBlocker,
          action,
        })) {
          lastError = error;
          if (attempt < maxOpenAttempts) {
            await cleanupTrackedPages();
            continue;
          }
        }
        if (clickBlocker) {
          await onDetailFailure(targetPage, 'pdd-order-remark-click-blocked', clickBlocker).catch(() => {});
          throw new Error(`拼多多页面存在未识别的遮挡弹窗，禁止强制点击查看详情: ${JSON.stringify(clickBlocker)}`);
        }
        lastError = error;
        if (attempt < maxOpenAttempts) {
          await cleanupTrackedPages();
          await sleep(Math.max(500, pollMs * 2));
          continue;
        }
        throw error;
      }
      const popupPage = await popupPromise;
      if (popupPage) {
        trackedPages.add(popupPage);
        await popupPage.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
      }

      try {
        const waitOptions = {
          sourcePage: targetPage,
          initialPages,
          trackedPages,
          orderNumber,
          initialText,
          initialUrl: attemptUrl,
          timeoutMs,
          pollMs,
          reopenAfterMs: Math.min(timeoutMs, Math.max(1_000, popupTimeoutMs * 2)),
          onVerification,
        };
        let detail;
        let renderError = null;
        try {
          detail = await waitForRenderedOrderDetail(waitOptions);
        } catch (error) {
          renderError = error;
        }

        const refreshRequired = detail?.reopenRequired
          || /未在限定时间内完成渲染/.test(renderError?.message || '');
        if (refreshRequired) {
          const reusablePage = popupPage && !popupPage.isClosed()
            ? popupPage
            : [...trackedPages].find((page) => page !== targetPage && !page.isClosed());
          if (reusablePage) {
            await cleanupTrackedPages(reusablePage);
            try {
              await action('refresh-order-info-detail', () => reusablePage.reload({
                waitUntil: 'domcontentloaded',
                timeout: timeoutMs,
              }));
            } catch (error) {
              // Navigation may reach the detail URL before the load event
              // times out. Let the render check decide whether it is usable.
              if (!isObservedReloadInterruption(error)) throw error;
            }
            renderError = null;
            try {
              detail = await waitForRenderedOrderDetail({
                ...waitOptions,
                reopenAfterMs: timeoutMs,
              });
            } catch (error) {
              renderError = error;
            }
          }
        }

        if (detail?.scope) {
          await cleanupTrackedPages(detail.page);
          trackedPages.delete(detail.page);
          return { detail, originalUrl };
        }
        if (renderError) throw renderError;
        lastError = new Error('拼多多订单详情未在限定时间内完成渲染');
        if (attempt === maxOpenAttempts) throw lastError;
      } catch (error) {
        lastError = error;
        const wrongOrderDetail = /订单号与当前工单不一致/.test(error.message);
        const canReopen = wrongOrderDetail || (
          /未在限定时间内完成渲染/.test(error.message)
          && Boolean(await findOrderInfoDetailAction(targetPage))
        );
        if (!canReopen || attempt === maxOpenAttempts) throw error;
        if (wrongOrderDetail) {
          await cleanupTrackedPages();
          try {
            await action('return-from-wrong-order-detail', () => targetPage.goto(originalUrl, {
              waitUntil: 'domcontentloaded',
              timeout: timeoutMs,
            }));
          } catch (navigationError) {
            if (!isObservedReloadInterruption(navigationError)) throw navigationError;
          }
        }
      }

      await cleanupTrackedPages();
    }
    throw lastError || new Error('拼多多订单详情未在限定时间内完成渲染');
  } finally {
    await cleanupTrackedPages();
  }
};

export async function inspectPddOrderRemark({
  targetPage,
  orderNumber,
  remarkText = '自动化',
  colorLabel = '红色',
  action = async (_name, callback) => callback(),
  timeoutMs = 30_000,
  popupTimeoutMs = 1_500,
  pollMs = 250,
  settleMs = 1_000,
  onVerification,
}) {
  if (!targetPage || !orderNumber) throw new Error('拼多多备注核对缺少页面或订单号');
  const { detail, originalUrl } = await openRenderedOrderDetail({
    targetPage,
    orderNumber,
    action,
    timeoutMs,
    popupTimeoutMs,
    pollMs,
    onVerification,
    onDetailFailure: async () => {},
  });
  let state = 'unresolved';
  let observedText = detail.scope === detail.page
    ? await readText(detail.page)
    : await detail.scope.innerText().catch(() => '');
  let observedColor = null;
  if (observedText.includes(remarkText)) {
    state = 'confirmed';
  } else {
    const entry = await waitForRemarkEntry({
      scope: detail.scope,
      timeoutMs: Math.min(timeoutMs, Math.max(5_000, settleMs * 5)),
      pollMs,
    });
    const entryText = await entry?.innerText().catch(() => '') || '';
    if (entry) {
      await action('inspect-order-remark', () => entry.click());
      const input = await firstVisible([
        detail.scope.locator('textarea:visible'),
        detail.scope.getByPlaceholder(/备注|请输入/),
        detail.scope.getByRole('textbox'),
        detail.page.locator('[role="dialog"]:visible textarea:visible, [class*="modal" i]:visible textarea:visible'),
        detail.page.locator('textarea:visible').last(),
        detail.page.getByPlaceholder(/备注|请输入/).last(),
      ]);
      if (input) {
        observedText = await input.inputValue().catch(() => '');
        const inputDialog = input.locator('xpath=ancestor::*[@role="dialog" or contains(translate(@class,"MODAL","modal"),"modal")][1]');
        const remarkScope = await firstVisible([inputDialog]) || detail.scope;
        const colorOption = await firstVisible([
          remarkScope.getByRole('button', { name: new RegExp(`^${colorLabel}`) }),
          remarkScope.locator('label').filter({ hasText: new RegExp(`^\\s*${colorLabel}\\s*$`) }),
          remarkScope.getByText(colorLabel, { exact: true }),
        ]);
        observedColor = colorOption && await isRemarkColorSelected(colorOption, colorLabel)
          ? colorLabel
          : null;
        state = observedText.includes(remarkText) ? 'confirmed' : 'not-applied';
        await dismissRemarkEditor({ input, scope: remarkScope, page: detail.page, action, settleMs });
      } else if (/添加备注/.test(entryText)) {
        state = 'not-applied';
      }
    }
  }
  await returnToWorkOrder({ sourcePage: targetPage, detail, originalUrl, action });
  return {
    state,
    orderNumber,
    remarkText,
    colorLabel,
    observedText,
    observedColor,
    detailMode: detail.mode,
    readOnly: true,
    observedAt: new Date().toISOString(),
  };
}

export async function addPddOrderRemark({
  targetPage,
  orderNumber,
  remarkText = '自动化',
  colorLabel = '红色',
  action = async (_name, callback) => callback(),
  guardSave = async (callback) => ({ result: await callback(), alreadySucceeded: false }),
  timeoutMs = 30_000,
  popupTimeoutMs = 1_500,
  pollMs = 250,
  settleMs = 1_000,
  onVerification,
  onDetailFailure = async () => {},
}) {
  if (!targetPage || !orderNumber) throw new Error('拼多多备注缺少页面或订单号');
  let { detail, originalUrl } = await openRenderedOrderDetail({
    targetPage,
    orderNumber,
    action,
    timeoutMs,
    popupTimeoutMs,
    pollMs,
    onVerification,
    onDetailFailure,
  });
  if (await hasVisibleRemarkText(detail.scope, remarkText)) {
    await returnToWorkOrder({ sourcePage: targetPage, detail, originalUrl, action });
    return {
      remarkStatus: 'saved',
      remarkColor: colorLabel,
      detailMode: detail.mode,
      alreadySucceeded: true,
      confirmationMethod: 'existing-remark-text',
    };
  }
  const entryTimeoutMs = Math.min(timeoutMs, Math.max(5_000, settleMs * 5));
  let entryState = await waitForActionableRemarkEntry({
    scope: detail.scope,
    page: detail.page,
    timeoutMs: entryTimeoutMs,
    pollMs,
    onVerification,
  });
  let { entry } = entryState;
  if (!entry) {
    await returnToWorkOrder({ sourcePage: targetPage, detail, originalUrl, action });
    try {
      await action('refresh-work-order-for-remark-retry', () => targetPage.reload({
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      }));
    } catch (error) {
      if (!isObservedReloadInterruption(error)) throw error;
    }
    await sleep(settleMs);
    ({ detail, originalUrl } = await openRenderedOrderDetail({
      targetPage,
      orderNumber,
      action,
      timeoutMs,
      popupTimeoutMs,
      pollMs,
      onVerification,
      onDetailFailure,
    }));
    if (await hasVisibleRemarkText(detail.scope, remarkText)) {
      await returnToWorkOrder({ sourcePage: targetPage, detail, originalUrl, action });
      return {
        remarkStatus: 'saved',
        remarkColor: colorLabel,
        detailMode: detail.mode,
        alreadySucceeded: true,
        confirmationMethod: 'existing-remark-text-after-refresh',
      };
    }
    const retryEntryState = await waitForActionableRemarkEntry({
      scope: detail.scope,
      page: detail.page,
      timeoutMs: entryTimeoutMs,
      pollMs,
      onVerification,
    });
    entryState = {
      entry: retryEntryState.entry,
      disabledSeen: entryState.disabledSeen || retryEntryState.disabledSeen,
    };
    ({ entry } = entryState);
  }
  if (!entry) {
    try {
      await onDetailFailure(detail.page, 'pdd-order-remark-entry-missing');
    } catch {}
    await returnToWorkOrder({ sourcePage: targetPage, detail, originalUrl, action });
    if (entryState.disabledSeen) throw transientRemarkEntryError();
    throw new Error('拼多多订单详情刷新并重新打开后仍未找到添加备注或修改备注入口');
  }

  await action('open-order-remark', () => entry.click());
  const input = await firstVisible([
    detail.scope.locator('textarea:visible'),
    detail.scope.getByPlaceholder(/备注|请输入/),
    detail.scope.getByRole('textbox'),
    detail.page.locator('[role="dialog"]:visible textarea:visible, [class*="modal" i]:visible textarea:visible'),
    detail.page.locator('textarea:visible').last(),
    detail.page.getByPlaceholder(/备注|请输入/).last(),
  ]);
  if (!input) throw new Error('拼多多备注弹窗未找到输入框');
  const inputDialog = input.locator('xpath=ancestor::*[@role="dialog" or contains(translate(@class,"MODAL","modal"),"modal")][1]');
  const remarkScope = await firstVisible([inputDialog]) || detail.scope;
  await selectRemarkColor({
    scope: remarkScope,
    colorLabel,
    action,
    settleMs,
    pollMs,
  });
  await action('fill-order-remark', () => input.fill(remarkText));
  const save = await firstVisible([
    remarkScope.getByRole('button', { name: /^(?:保存|确定|提交|保存备注)$/ }),
    remarkScope.getByText(/^(?:保存备注|保存|确定)$/, { exact: true }),
    detail.scope.getByRole('button', { name: /^(?:保存|确定|提交|保存备注)$/ }),
    detail.scope.getByText(/^(?:保存备注|保存|确定)$/, { exact: true }),
    detail.page.getByRole('button', { name: /^(?:保存|确定|提交|保存备注)$/ }),
    detail.page.getByText(/^(?:保存备注|保存|确定)$/, { exact: true }),
  ]);
  if (!save) throw new Error('拼多多备注弹窗未找到保存按钮');

  const guarded = await guardSave(async () => {
    await action('save-order-remark', () => save.click(), { retryOnRateLimit: true });
    const deadline = Date.now() + Math.max(5000, settleMs * 10);
    let hiddenSince = null;
    while (Date.now() < deadline) {
      const pageText = detail.page.isClosed() ? '' : await readText(detail.page);
      const scopeText = detail.page.isClosed()
        ? ''
        : detail.scope === detail.page
          ? pageText
          : await detail.scope.innerText().catch(() => '');
      if (scopeText.includes(remarkText) || /备注(?:保存)?成功/.test(scopeText)) return { saved: true };
      const editorVisible = !detail.page.isClosed() && await input.isVisible().catch(() => false);
      if (!editorVisible) {
        hiddenSince ||= Date.now();
        if (Date.now() - hiddenSince >= Math.max(1000, settleMs)) {
          return { saved: true, confirmationMethod: 'editor-closed-after-save' };
        }
      } else {
        hiddenSince = null;
      }
      await sleep(pollMs);
    }
    throw new Error('拼多多备注保存结果未确认');
  });
  await dismissRemarkEditor({ input, scope: remarkScope, page: detail.page, action, settleMs });
  await returnToWorkOrder({ sourcePage: targetPage, detail, originalUrl, action });
  return {
    remarkStatus: 'saved',
    remarkColor: colorLabel,
    detailMode: detail.mode,
    alreadySucceeded: Boolean(guarded?.alreadySucceeded),
  };
}
