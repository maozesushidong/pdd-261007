const normalize = value => String(value || '').replace(/\s+/gu, '').trim();
const controls = [
  '[role="combobox"]', 'select', '[data-testid="beast-core-select"]',
  '.ant-select-selector', '.el-select', '[class*="select-selector"]',
];
const visibleFirst = async locators => {
  for (const locator of locators) {
    for (let index = 0; index < await locator.count(); index++) {
      const item = locator.nth(index);
      if (await item.isVisible()) return item;
    }
  }
  return null;
};
const selectedLabel = async (control, scope) => {
  const candidates = await control.evaluate(element => {
    if (element.tagName === 'SELECT') return [element.selectedOptions[0]?.textContent || ''];
    const root = element.closest('[data-testid="beast-core-select"], .ant-select, .el-select');
    const beastInput = (root || element).querySelector('input[data-testid="beast-core-select-htmlInput"]');
    return [beastInput?.value, element.innerText, element.getAttribute('title'), element.value, root?.innerText].filter(Boolean);
  });
  if (scope) candidates.push((await scope.innerText()).replace(/^\s*工单状态\s*/u, ''));
  return candidates.map(normalize).find(value => /^(?:全部|待处理|处理中|已完结|已完成|已关闭)$/u.test(value))
    || candidates.map(normalize).filter(Boolean).join(' | ');
};

// Reloading PDD's list restores the "全部" status filter. Its first page can
// consist entirely of completed cases: absence of "立即处理" is not a render
// failure and is not proof that there are no pending cases on later pages.
// Choose only the labelled status field, and read the selected value back.
const ensurePddListStatusFilter = async (page, selectedStatus, {
  beforeAction = async () => {}, timeoutMs = 5_000,
} = {}) => {
  await beforeAction(page, 'ordinary-list-pending-filter-before');
  const deadline = Date.now() + timeoutMs;
  let dropdown;
  let fieldScope;
  do {
    const labels = page.getByText('工单状态', { exact: true });
    for (let index = 0; index < await labels.count(); index++) {
      const label = labels.nth(index);
      if (!await label.isVisible()) continue;
      const scope = label.locator('xpath=ancestor::*[.//*[@role="combobox"] or .//select or .//*[contains(@class,"select")] or .//*[@data-testid="beast-core-select"]][1]');
      dropdown = await visibleFirst(controls.map(selector => scope.locator(selector)));
      if (dropdown) { fieldScope = scope; break; }
    }
    if (dropdown || Date.now() >= deadline) break;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  const fail = async message => {
    // Persist a stable machine-readable prefix with the transient failure.
    // Resident discovery stores only error.message, so relying on the
    // in-memory error.code would lose the safe-retry classification after a
    // worker restart.
    const error = new Error(`PDD_PENDING_LIST_FILTER_UNCONFIRMED: ${message}`);
    error.code = 'PDD_PENDING_LIST_FILTER_UNCONFIRMED';
    error.retryable = true;
    error.diagnostics = { url: page.url(), selected: dropdown ? await selectedLabel(dropdown, fieldScope).catch(() => null) : null,
      controlHtml: dropdown ? await dropdown.evaluate(el => el.outerHTML).catch(() => null) : null,
      fieldHtml: fieldScope ? (await fieldScope.evaluate(el => el.outerHTML).catch(() => '')).slice(0,8000) : null };
    console.warn(JSON.stringify({ source: 'pdd-pending-filter-unconfirmed', ...error.diagnostics }));
    throw error;
  };
  if (!dropdown) return fail('拼多多工单列表未找到明确的工单状态筛选，停止本轮扫描');
  const previous = await selectedLabel(dropdown, fieldScope);
  if (previous === selectedStatus) return { changed: false, selected: selectedStatus };
  await beforeAction(page, 'ordinary-list-pending-filter-select');
  if (await dropdown.evaluate(element => element.tagName) === 'SELECT') {
    await dropdown.selectOption({ label: selectedStatus }, { timeout: timeoutMs });
  } else {
    await dropdown.click({ timeout: timeoutMs });
    const optionDeadline = Date.now() + timeoutMs;
    let selected = false;
    do {
      await beforeAction(page, 'ordinary-list-pending-filter-option');
      const options = page.locator([
        '[role="option"]:visible', '[data-testid="beast-core-select-option"]:visible',
        '.ant-select-item-option:visible', '.el-select-dropdown__item:visible',
        '[class*="select-option"]:visible',
      ].join(', '));
      for (let index = 0; index < await options.count(); index++) {
        const option = options.nth(index);
        if (normalize(await option.innerText()) !== selectedStatus) continue;
        await option.click({ timeout: timeoutMs });
        selected = true;
        break;
      }
      if (selected || Date.now() >= optionDeadline) break;
      await page.waitForTimeout(100);
    } while (Date.now() < optionDeadline);
    if (!selected) return fail(`拼多多工单状态筛选未找到${selectedStatus}选项，停止本轮查询`);
  }
  const retainedDeadline = Date.now() + timeoutMs;
  do {
    await beforeAction(page, 'ordinary-list-pending-filter-verify');
    if (await selectedLabel(dropdown, fieldScope) === selectedStatus) return { changed: true, previous, selected: selectedStatus };
    if (Date.now() >= retainedDeadline) break;
    await page.waitForTimeout(100);
  } while (Date.now() < retainedDeadline);
  return fail(`拼多多工单状态未保持为${selectedStatus}，停止本轮查询`);
};

export const ensurePddPendingListFilter = (page, options) => ensurePddListStatusFilter(page, '待处理', options);

// Exact-order recovery and completion checks must not inherit discovery's
// pending-only filter: a hidden processing case is not an absent case.
export const ensurePddAllListStatuses = (page, options) => ensurePddListStatusFilter(page, '全部', options);
