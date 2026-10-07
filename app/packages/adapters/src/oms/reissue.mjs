export const OMS_REISSUE_REASON_LABEL_PATTERN = /^(?:补发原因|补发类型|业务类型)\s*[:：]?$/u;

const firstVisible = async (candidates) => {
  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const element = candidate.nth(index);
      if (await element.isVisible().catch(() => false)) return element;
    }
  }
  return null;
};

const reissueReasonControlForLabel = async (label) => {
  const formItem = label.locator(
    'xpath=ancestor::*['
      + 'contains(concat(" ",normalize-space(@class)," ")," el-form-item ")'
      + ' or contains(concat(" ",normalize-space(@class)," ")," form-item ")'
      + ' or contains(concat(" ",normalize-space(@class)," ")," field ")][1]',
  );
  const sibling = label.locator('xpath=following-sibling::*[1]');
  const parent = label.locator('xpath=parent::*');
  const controlSelector = [
    '.el-select',
    '[role="combobox"]',
    'input[role="combobox"]',
    '.el-input',
  ].join(', ');
  const select = await firstVisible([
    formItem.locator(controlSelector).first(),
    sibling.locator(controlSelector).first(),
    label.locator(
      'xpath=following-sibling::*[1][@role="combobox"'
        + ' or contains(concat(" ",normalize-space(@class)," ")," el-select ")'
        + ' or contains(concat(" ",normalize-space(@class)," ")," el-input ")]',
    ),
    parent.locator(controlSelector).first(),
  ]);
  if (!select) return null;
  const scope = await firstVisible([formItem, parent]) || parent;
  return { scope, select };
};

const selectedControlValue = async (select, scope) => {
  const values = [
    await select.innerText().catch(() => ''),
    await select.inputValue().catch(() => ''),
    await select.locator('input').first().inputValue().catch(() => ''),
    await scope.innerText().catch(() => ''),
  ];
  return values.map((value) => String(value || '').trim()).filter(Boolean).join('\n');
};

const waitForSelectedControlValue = async (
  targetPage,
  field,
  optionText,
  deadline,
  pollMs,
) => {
  while (Date.now() < deadline) {
    const selectedText = await selectedControlValue(field.select, field.scope);
    if (selectedText.includes(optionText)) return true;
    await targetPage.waitForTimeout(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  return false;
};

const inspectOmsReissueReasonSelection = async (field, optionText) => {
  const selectedText = await selectedControlValue(field.select, field.scope);
  const validation = await field.scope.evaluate((root) => {
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    };
    const controls = [...root.querySelectorAll([
      'input', 'textarea', 'select', '[role="combobox"]', '[contenteditable="true"]',
    ].join(', '))].filter(visible);
    const errorTexts = [...root.querySelectorAll([
      '.el-form-item__error', '[class*="form-item__error"]',
      '[role="alert"]', '[aria-live="assertive"]',
    ].join(', '))]
      .filter(visible)
      .map((element) => String(element.textContent || '').replace(/\s+/gu, ' ').trim())
      .filter(Boolean);
    const modelOutOfSync = controls.some((control) => {
      if (!('value' in control) || !String(control.value || '').trim()) return false;
      if (Object.prototype.hasOwnProperty.call(control, '_value')
        && String(control.value || '').trim() !== String(control._value || '').trim()) return true;
      let candidate = control;
      while (candidate && root.contains(candidate)) {
        const props = candidate.__vueParentComponent?.props;
        if (props && Object.prototype.hasOwnProperty.call(props, 'modelValue')) {
          return String(control.value || '').trim() !== String(props.modelValue || '').trim();
        }
        candidate = candidate.parentElement;
      }
      return false;
    });
    return {
      invalid: root.classList.contains('is-error')
        || controls.some((control) => control.getAttribute('aria-invalid') === 'true')
        || errorTexts.length > 0
        || modelOutOfSync,
      errorTexts,
      modelOutOfSync,
    };
  }).catch((error) => ({
    invalid: true,
    inspectionError: String(error?.message || error),
  }));
  return {
    ...validation,
    selectedText,
    selected: selectedText.includes(optionText),
    valid: selectedText.includes(optionText) && !validation.invalid,
  };
};

const blurAndWaitForCommittedReason = async (
  targetPage,
  field,
  optionText,
  deadline,
  pollMs,
) => {
  await field.select.locator('input').first().blur().catch(() => {});
  await field.select.blur().catch(() => {});
  let inspection = await inspectOmsReissueReasonSelection(field, optionText);
  while (Date.now() < deadline) {
    if (inspection.valid) return inspection;
    await targetPage.waitForTimeout(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    inspection = await inspectOmsReissueReasonSelection(field, optionText);
  }
  return inspection;
};

const describeElement = async (element) => element.evaluate((node) => {
  const compact = (value, limit = 500) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const attributeNames = [
    'id', 'class', 'role', 'name', 'type', 'value', 'placeholder', 'aria-label',
    'aria-expanded', 'aria-controls', 'aria-haspopup', 'data-v-5bd173d5',
  ];
  const attributes = Object.fromEntries(attributeNames
    .map((name) => [name, node.getAttribute?.(name)])
    .filter(([, value]) => value !== null && value !== ''));
  const parent = node.parentElement;
  const vueEventBindings = Object.keys(node._vei || {});
  const componentProps = node.__vueParentComponent?.props || {};
  return {
    tag: String(node.tagName || '').toLowerCase(),
    attributes,
    text: compact(node.textContent),
    inputValue: 'value' in node ? compact(node.value, 200) : null,
    vue: {
      eventBindings: vueEventBindings,
      hasClickBinding: vueEventBindings.some((key) => /click/iu.test(key)),
      componentName: compact(
        node.__vueParentComponent?.type?.name
          || node.__vueParentComponent?.type?.__name,
        120,
      ) || null,
      disabled: componentProps.disabled ?? null,
      loading: componentProps.loading ?? null,
      nativeType: compact(componentProps.nativeType, 40) || null,
    },
    outerHtml: compact(node.outerHTML, 1_200),
    parent: parent ? {
      tag: String(parent.tagName || '').toLowerCase(),
      class: compact(parent.className, 300),
      text: compact(parent.textContent),
    } : null,
  };
}).catch((error) => ({ describeError: String(error?.message || error) }));

const describeVisibleElements = async (locator, limit = 12) => {
  const rows = [];
  const count = Math.min(await locator.count().catch(() => 0), limit);
  for (let index = 0; index < count; index += 1) {
    const element = locator.nth(index);
    if (!await element.isVisible().catch(() => false)) continue;
    rows.push(await describeElement(element));
  }
  return rows;
};

export const inspectOmsFlatBatchReissueForm = async (dialog) => dialog.evaluate((root) => {
  const compact = (value, limit = 300) => String(value || '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);
  const visible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && rect.width > 0
      && rect.height > 0;
  };
  const valuePresent = (control) => {
    const type = String(control.getAttribute('type') || '').toLowerCase();
    if (['checkbox', 'radio'].includes(type)) return Boolean(control.checked);
    if ('value' in control && compact(control.value)) return true;
    if (control.getAttribute('contenteditable') === 'true' && compact(control.textContent)) return true;
    return false;
  };
  const controlState = (control, item) => {
    const domValue = 'value' in control ? compact(control.value, 200) : '';
    const vueBoundValueObserved = Object.prototype.hasOwnProperty.call(control, '_value');
    const vueBoundValue = vueBoundValueObserved ? compact(control._value, 200) : '';
    let componentModelValueObserved = false;
    let componentModelValue = '';
    let candidate = control;
    while (candidate && item.contains(candidate)) {
      const component = candidate.__vueParentComponent;
      if (component?.props
        && Object.prototype.hasOwnProperty.call(component.props, 'modelValue')) {
        componentModelValueObserved = true;
        componentModelValue = compact(component.props.modelValue, 200);
        break;
      }
      candidate = candidate.parentElement;
    }
    return {
      tag: String(control.tagName || '').toLowerCase(),
      type: compact(control.getAttribute('role')
        || control.getAttribute('type')
        || control.tagName.toLowerCase(), 40),
      domValuePresent: Boolean(domValue),
      vueBoundValueObserved,
      vueBoundValuePresent: vueBoundValueObserved ? Boolean(vueBoundValue) : null,
      domMatchesVueBoundValue: vueBoundValueObserved ? domValue === vueBoundValue : null,
      componentModelValueObserved,
      componentModelValuePresent: componentModelValueObserved
        ? Boolean(componentModelValue)
        : null,
      domMatchesComponentModelValue: componentModelValueObserved
        ? domValue === componentModelValue
        : null,
      ariaInvalid: control.getAttribute('aria-invalid'),
    };
  };
  const itemLabel = (item) => compact(
    item.querySelector('.el-form-item__label, [class*="form-item__label"], label')?.textContent,
    120,
  ).replace(/^\s*[＊*]\s*/u, '');
  const items = [...root.querySelectorAll('.el-form-item, [class*="form-item"]')]
    .filter((item, index, all) => visible(item)
      && all.findIndex((candidate) => candidate === item) === index)
    .map((item) => {
      const label = itemLabel(item);
      const controls = [...item.querySelectorAll([
        'input', 'textarea', 'select', '[role="combobox"]', '[role="radio"]',
        '[role="checkbox"]', '[contenteditable="true"]',
      ].join(', '))].filter(visible);
      const selectedText = compact([
        ...item.querySelectorAll([
          '.el-select__selected-item', '.el-select-dropdown__item.selected',
          '.el-radio.is-checked', '.el-checkbox.is-checked',
          '[aria-selected="true"]', '[aria-checked="true"]',
        ].join(', ')),
      ].filter(visible).map((element) => element.textContent).join(' '), 160);
      const required = item.classList.contains('is-required')
        || item.matches('[aria-required="true"]')
        || controls.some((control) => control.required
          || control.getAttribute('aria-required') === 'true')
        || /^\s*[＊*]/u.test(compact(
          item.querySelector('.el-form-item__label, [class*="form-item__label"], label')?.textContent,
        ));
      const errorTexts = [...item.querySelectorAll([
        '.el-form-item__error', '[class*="form-item__error"]',
        '[role="alert"]', '[aria-live="assertive"]',
      ].join(', '))].filter(visible).map((element) => compact(element.textContent, 200)).filter(Boolean);
      const controlStates = required
        ? controls.map((control) => controlState(control, item))
        : [];
      const modelOutOfSync = controlStates.some((state) => state.domValuePresent && (
        (state.vueBoundValueObserved && !state.domMatchesVueBoundValue)
        || (state.componentModelValueObserved && !state.domMatchesComponentModelValue)
      ));
      const invalid = item.classList.contains('is-error')
        || controls.some((control) => control.getAttribute('aria-invalid') === 'true'
          || (typeof control.checkValidity === 'function' && !control.checkValidity()))
        || errorTexts.length > 0
        || modelOutOfSync;
      const filled = controls.some(valuePresent) || Boolean(selectedText);
      return {
        label: label || '(未读取到标签)',
        required,
        filled,
        invalid,
        disabled: controls.length > 0 && controls.every((control) => (
          control.disabled || control.getAttribute('aria-disabled') === 'true'
        )),
        controlCount: controls.length,
        controlTypes: [...new Set(controls.map((control) => compact(
          control.getAttribute('role')
            || control.getAttribute('type')
            || control.tagName.toLowerCase(),
          40,
        )))],
        controlStates,
        selectedText,
        errorTexts,
      };
    });
  const requiredItems = items.filter((item) => item.required);
  const blockingItems = requiredItems.filter((item) => !item.filled || item.invalid);
  return {
    valid: blockingItems.length === 0,
    itemCount: items.length,
    requiredCount: requiredItems.length,
    blockingItems,
    requiredItems,
    inspectedAt: new Date().toISOString(),
  };
}).catch((error) => ({
  valid: false,
  inspectionError: String(error?.message || error),
  blockingItems: [{
    label: '(表单诊断失败)',
    required: true,
    filled: false,
    invalid: true,
  }],
  inspectedAt: new Date().toISOString(),
}));

const customPickerForOption = async (targetPage, option) => firstVisible([
  option.locator(
    'xpath=ancestor::*['
      + 'contains(concat(" ",normalize-space(@class)," ")," data-dict-item-selector-popper-class ")'
      + ' or contains(concat(" ",normalize-space(@class)," ")," el-dialog ")'
      + ' or contains(concat(" ",normalize-space(@class)," ")," el-drawer ")][1]',
  ),
  targetPage.locator('.data-dict-item-selector-popper-class').first(),
]);

const confirmCustomPickerSelection = async (targetPage, option, deadline, pollMs) => {
  const picker = await customPickerForOption(targetPage, option);
  if (!picker) return null;
  const roleConfirmButtons = picker.getByRole('button', {
    name: /^(?:确定|确认|选择|确认选择)$/u,
  });
  const textConfirmButtons = picker.locator('button')
    .filter({ hasText: /^(?:确定|确认|选择|确认选择)$/u });
  if (
    await roleConfirmButtons.count().catch(() => 0) === 0
    && await textConfirmButtons.count().catch(() => 0) === 0
  ) return picker;
  const confirmationDeadline = Math.min(deadline, Date.now() + 3_000);
  while (Date.now() < confirmationDeadline) {
    const confirm = await firstVisible([
      roleConfirmButtons,
      textConfirmButtons,
    ]);
    if (confirm && await confirm.isEnabled().catch(() => false)) {
      await confirm.click({ force: true });
      return picker;
    }
    await targetPage.waitForTimeout(Math.min(
      pollMs,
      Math.max(1, confirmationDeadline - Date.now()),
    ));
  }
  return picker;
};

const finalizeCustomPickerSelection = async (
  targetPage,
  picker,
  option,
  field,
  optionText,
  deadline,
  pollMs,
) => {
  if (!picker || !await picker.isVisible().catch(() => false)) return;

  // The live OMS dictionary writes the selected text after one click but only
  // commits and closes the picker after a double-click. Never leave that
  // overlay open when the outer batch-reissue submit button is used.
  const optionRow = option.locator('xpath=ancestor::tr[1]');
  if (await optionRow.isVisible().catch(() => false)) {
    await optionRow.dblclick({ force: true }).catch(() => {});
  } else if (await option.isVisible().catch(() => false)) {
    await option.dblclick({ force: true }).catch(() => {});
  }

  const closeDeadline = Math.min(deadline, Date.now() + 2_000);
  while (Date.now() < closeDeadline && await picker.isVisible().catch(() => false)) {
    await targetPage.waitForTimeout(Math.min(pollMs, Math.max(1, closeDeadline - Date.now())));
  }
  if (await picker.isVisible().catch(() => false)) {
    await targetPage.keyboard.press('Escape').catch(() => {});
    await picker.waitFor({ state: 'hidden', timeout: 1_500 }).catch(() => {});
  }
  if (await picker.isVisible().catch(() => false)) {
    throw new Error(`OMS 补发业务类型“${optionText}”已显示但字典弹层未关闭`);
  }
  const selectedText = await selectedControlValue(field.select, field.scope);
  if (!selectedText.includes(optionText)) {
    throw new Error(`OMS 补发业务类型“${optionText}”关闭字典弹层后未保持`);
  }
};

const findOmsReissueReasonOption = async (targetPage, optionText, deadline, pollMs) => {
  while (Date.now() < deadline) {
    const option = await firstVisible([
      targetPage.locator('.data-dict-item-selector-popper-class')
        .getByText(optionText, { exact: true }),
      targetPage.getByRole('option', { name: optionText, exact: true }),
      targetPage.getByText(optionText, { exact: true }).last(),
    ]);
    if (option) return option;
    await targetPage.waitForTimeout(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  return null;
};

const logSelectionDiagnostic = async ({ targetPage, label, field, option, optionText }) => {
  const picker = option ? await customPickerForOption(targetPage, option) : null;
  const diagnostic = {
    url: targetPage.url(),
    title: await targetPage.title().catch(() => ''),
    optionText,
    label: label ? await describeElement(label) : null,
    selectedControl: field?.select ? await describeElement(field.select) : null,
    fieldScope: field?.scope ? await describeElement(field.scope) : null,
    option: option ? await describeElement(option) : null,
    optionRow: option ? await describeElement(option.locator('xpath=ancestor::tr[1]')) : null,
    customPicker: picker ? await describeElement(picker) : null,
    customPickerButtons: picker
      ? await describeVisibleElements(picker.locator('button, [role="button"]'))
      : [],
    visibleComboboxes: await describeVisibleElements(targetPage.locator(
      '[role="combobox"], input[role="combobox"], .el-select, .el-cascader, .el-input',
    )),
    visibleOptionTextElements: await describeVisibleElements(
      targetPage.getByText(optionText, { exact: true }),
    ),
  };
  console.warn(`[oms-reissue-reason-diagnostic] ${JSON.stringify(diagnostic)}`);
};

export const selectOmsReissueReason = async (
  targetPage,
  optionText = '快递责任补发',
  {
    timeoutMs = 30_000,
    pollIntervalMs = 250,
  } = {},
) => {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 30_000);
  const pollMs = Math.max(10, Number(pollIntervalMs) || 250);
  let field = null;
  let selectedLabel = null;
  let labelObserved = false;
  while (Date.now() < deadline) {
    const label = await firstVisible([
      targetPage.getByText(OMS_REISSUE_REASON_LABEL_PATTERN).first(),
      targetPage.locator('label, .el-form-item__label, [class*="form-item__label"]')
        .filter({ hasText: OMS_REISSUE_REASON_LABEL_PATTERN }).first(),
    ]);
    if (label) {
      labelObserved = true;
      selectedLabel = label;
      field = await reissueReasonControlForLabel(label);
      if (field) break;
    }
    await targetPage.waitForTimeout(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  if (!field) {
    throw new Error(labelObserved
      ? `OMS 补发页面等待 ${timeoutMs} 毫秒仍未找到“${optionText}”下拉框`
      : `OMS 补发页面等待 ${timeoutMs} 毫秒仍未找到“${optionText}”对应字段`);
  }

  await field.select.click({ force: true });
  let option = await findOmsReissueReasonOption(targetPage, optionText, deadline, pollMs);
  if (!option) throw new Error(`OMS 补发页面下拉框未找到“${optionText}”`);
  await option.click({ force: true });
  const initialPicker = await confirmCustomPickerSelection(
    targetPage,
    option,
    deadline,
    pollMs,
  );

  const singleClickDeadline = Math.min(deadline, Date.now() + 1_500);
  if (await waitForSelectedControlValue(
    targetPage,
    field,
    optionText,
    singleClickDeadline,
    pollMs,
  )) {
    await finalizeCustomPickerSelection(
      targetPage,
      initialPicker,
      option,
      field,
      optionText,
      deadline,
      pollMs,
    );
    const initialCommit = await blurAndWaitForCommittedReason(
      targetPage,
      field,
      optionText,
      Math.min(deadline, Date.now() + 1_500),
      pollMs,
    );
    if (initialCommit.valid) return optionText;
  }

  const visiblePicker = await firstVisible([
    targetPage.locator('.data-dict-item-selector-popper-class').first(),
  ]);
  if (!visiblePicker) await field.select.click({ force: true });
  option = await findOmsReissueReasonOption(targetPage, optionText, deadline, pollMs);
  if (!option) throw new Error(`OMS 补发页面重新打开下拉框后未找到“${optionText}”`);
  const optionRow = option.locator('xpath=ancestor::tr[1]');
  if (await optionRow.isVisible().catch(() => false)) {
    await optionRow.dblclick({ force: true });
  } else {
    await option.dblclick({ force: true });
  }
  const committedPicker = await confirmCustomPickerSelection(
    targetPage,
    option,
    deadline,
    pollMs,
  );

  if (await waitForSelectedControlValue(targetPage, field, optionText, deadline, pollMs)) {
    await finalizeCustomPickerSelection(
      targetPage,
      committedPicker,
      option,
      field,
      optionText,
      deadline,
      pollMs,
    );
    const committedReason = await blurAndWaitForCommittedReason(
      targetPage,
      field,
      optionText,
      deadline,
      pollMs,
    );
    if (committedReason.valid) return optionText;
  }
  await logSelectionDiagnostic({
    targetPage,
    label: selectedLabel,
    field,
    option,
    optionText,
  });
  throw new Error(`OMS 补发业务类型“${optionText}”选择后未保持`);
};

export const submitOmsFlatBatchReissue = async (
  targetPage,
  dialog,
  {
    timeoutMs = 15_000,
    pollIntervalMs = 100,
    orderNumber = null,
  } = {},
) => {
  const finalButtonPattern = /^(?:确定|保存|提交|确认)$/u;
  const submit = await firstVisible([
    dialog.locator('.el-dialog__footer, [class*="dialog__footer"], .dialog-footer, footer')
      .getByRole('button', { name: finalButtonPattern }),
    dialog.locator('.el-dialog__footer, [class*="dialog__footer"], .dialog-footer, footer')
      .locator('button').filter({ hasText: finalButtonPattern }),
    dialog.getByRole('button', { name: finalButtonPattern }).last(),
    dialog.locator('button').filter({ hasText: finalButtonPattern }).last(),
  ]);
  if (!submit) throw new Error('OMS 批量补发页面未找到最终提交按钮');
  const preSubmitForm = await inspectOmsFlatBatchReissueForm(dialog);
  if (!preSubmitForm.valid) {
    const missingLabels = preSubmitForm.blockingItems
      .map((item) => item.label)
      .filter(Boolean)
      .join('、');
    const error = new Error(`OMS 批量补发表单必填项未满足：${missingLabels || '未读取到具体字段'}`);
    error.externalEffectStatus = 'failed';
    error.externalEffectReceipt = {
      clickAttempted: false,
      reason: 'oms-reissue-required-fields-incomplete',
      formDiagnostic: preSubmitForm,
    };
    throw error;
  }
  if (!await submit.isEnabled().catch(() => false)) {
    const error = new Error('OMS 批量补发最终提交按钮不可用');
    error.externalEffectStatus = 'failed';
    error.externalEffectReceipt = {
      clickAttempted: false,
      reason: 'oms-reissue-submit-disabled',
    };
    throw error;
  }

  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 15_000);
  const pollMs = Math.max(20, Number(pollIntervalMs) || 100);
  const responseTasks = [];
  const requests = [];
  const responses = [];
  let nativeDialog = null;
  let confirmationObserved = false;
  let confirmationClicked = false;
  const batchExecution = {
    observed: false,
    orderNumber: String(orderNumber || '').trim() || null,
    orderMatched: false,
    singleOrder: false,
    startClicked: false,
    startClickedAt: null,
    terminal: false,
    succeeded: false,
    failed: false,
    skipped: false,
    snapshots: [],
  };
  const compactNetworkUrl = (value) => {
    try {
      const parsed = new URL(value);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return String(value || '').slice(0, 500);
    }
  };
  const onDialog = (browserDialog) => {
    nativeDialog = {
      type: browserDialog.type(),
      message: String(browserDialog.message() || '').slice(0, 500),
    };
    browserDialog.accept().catch(() => {});
  };
  const onRequest = (request) => {
    if (request.method() === 'GET' || !/jeoms\.com/iu.test(request.url())) return;
    if (requests.length >= 12) return;
    const body = String(request.postData() || '');
    requests.push({
      method: request.method(),
      url: compactNetworkUrl(request.url()),
      bodyBytes: Buffer.byteLength(body),
    });
  };
  const onResponse = (response) => {
    const request = response.request();
    if (request.method() === 'GET' || !/jeoms\.com/iu.test(response.url())) return;
    if (responseTasks.length >= 12) return;
    const task = (async () => {
      const contentType = String(await response.headerValue('content-type').catch(() => '') || '');
      const body = /(?:json|text|javascript)/iu.test(contentType)
        ? String(await response.text().catch(() => '') || '').slice(0, 2_000)
        : null;
      responses.push({
        method: request.method(),
        url: compactNetworkUrl(response.url()),
        status: response.status(),
        ok: response.ok(),
        body,
      });
    })();
    responseTasks.push(task);
  };
  targetPage.on('dialog', onDialog);
  targetPage.on('request', onRequest);
  targetPage.on('response', onResponse);
  const clickedAt = new Date().toISOString();
  const clickAttempts = [];
  const waitForOutcome = async (attemptDeadline) => {
    let effectiveDeadline = attemptDeadline;
    const earliestCompletionAt = Date.now() + 500;
    while (Date.now() < effectiveDeadline) {
      const executionHeading = await firstVisible([
        targetPage.getByText('订单批量补发', { exact: true }),
      ]);
      const executionDialog = executionHeading ? await firstVisible([
        executionHeading.locator(
          'xpath=ancestor::*[@role="dialog"'
            + ' or contains(concat(" ",normalize-space(@class)," ")," el-dialog ")][1]',
        ),
        targetPage.locator('.el-dialog:visible').filter({ hasText: '订单批量补发' }),
      ]) : null;
      if (executionDialog) {
        if (!batchExecution.observed) {
          batchExecution.observed = true;
          effectiveDeadline = Math.max(effectiveDeadline, Date.now() + 60_000);
        }
        const text = String(await executionDialog.innerText().catch(() => ''))
          .replace(/\s+/gu, ' ')
          .trim();
        const numberFor = (pattern) => {
          const value = Number(text.match(pattern)?.[1]);
          return Number.isFinite(value) ? value : null;
        };
        const snapshot = {
          text: text.slice(0, 1_500),
          progressPercent: numberFor(/(?:^|\s)(\d{1,3})%/u),
          current: numberFor(/当前第\s*(\d+)\s*条/u),
          total: numberFor(/共\s*(\d+)\s*条/u),
          success: numberFor(/成功\s*(\d+)\s*条/u),
          failure: numberFor(/失败\s*(\d+)\s*条/u),
          skipped: numberFor(/跳过\s*(\d+)\s*条/u),
          observedAt: new Date().toISOString(),
        };
        const previousSnapshot = batchExecution.snapshots.at(-1);
        if (!previousSnapshot || JSON.stringify({ ...previousSnapshot, observedAt: null })
          !== JSON.stringify({ ...snapshot, observedAt: null })) {
          batchExecution.snapshots.push(snapshot);
          if (batchExecution.snapshots.length > 12) batchExecution.snapshots.shift();
        }
        batchExecution.orderMatched = !batchExecution.orderNumber
          || text.includes(batchExecution.orderNumber);
        batchExecution.singleOrder = snapshot.total === 1;
        if (!batchExecution.orderMatched || !batchExecution.singleOrder) {
          batchExecution.failed = true;
          batchExecution.failureReason = !batchExecution.orderMatched
            ? 'batch-execution-order-mismatch'
            : 'batch-execution-order-count-mismatch';
          break;
        }
        if (!batchExecution.startClicked) {
          const start = await firstVisible([
            executionDialog.getByRole('button', { name: /^开始$/u }),
            executionDialog.locator('button').filter({ hasText: /^开始$/u }),
          ]);
          if (!start || !await start.isEnabled().catch(() => false)) {
            batchExecution.failed = true;
            batchExecution.failureReason = 'batch-execution-start-unavailable';
            break;
          }
          await start.click({ timeout: 5_000 });
          batchExecution.startClicked = true;
          batchExecution.startClickedAt = new Date().toISOString();
          clickAttempts.push({
            attempt: clickAttempts.length + 1,
            action: 'batch-execution-start',
            clickedAt: batchExecution.startClickedAt,
          });
        }
        const terminalSuccess = batchExecution.startClicked
          && Number(snapshot.success || 0) >= 1
          && Number(snapshot.failure || 0) === 0;
        const terminalFailure = batchExecution.startClicked
          && Number(snapshot.failure || 0) >= 1;
        const terminalSkip = batchExecution.startClicked
          && Number(snapshot.skipped || 0) >= 1
          && !/未开始|进行中|处理中|执行中/u.test(text);
        if (terminalSuccess || terminalFailure || terminalSkip) {
          batchExecution.terminal = true;
          batchExecution.succeeded = terminalSuccess;
          batchExecution.failed = terminalFailure;
          batchExecution.skipped = terminalSkip;
          const close = await firstVisible([
            executionDialog.getByRole('button', { name: /关闭此对话框/u }),
            executionDialog.locator('.el-dialog__headerbtn'),
          ]);
          if (close) {
            await close.click({ force: true }).catch(() => {});
            await executionDialog.waitFor({ state: 'hidden', timeout: 2_000 }).catch(() => {});
          }
          break;
        }
        await targetPage.waitForTimeout(Math.min(
          pollMs,
          Math.max(1, effectiveDeadline - Date.now()),
        ));
        continue;
      }
      const confirmation = await firstVisible([
        targetPage.locator('.el-message-box:visible, [role="alertdialog"]:visible'),
      ]);
      if (confirmation) {
        confirmationObserved = true;
        const confirm = await firstVisible([
          confirmation.getByRole('button', { name: /^(?:确定|确认)$/u }),
          confirmation.getByText(/^(?:确定|确认)$/u, { exact: true }),
        ]);
        if (confirm && await confirm.isEnabled().catch(() => false)) {
          await confirm.click({ force: true });
          confirmationClicked = true;
          await confirmation.waitFor({ state: 'hidden', timeout: 2_000 }).catch(() => {});
        }
      }
      const outerDialogVisible = await dialog.isVisible().catch(() => false);
      if (Date.now() >= earliestCompletionAt
        && !outerDialogVisible
        && (!confirmation || !await confirmation.isVisible().catch(() => false))) break;
      await targetPage.waitForTimeout(Math.min(
        pollMs,
        Math.max(1, effectiveDeadline - Date.now()),
      ));
    }
  };
  const collectMessages = async () => {
    const messages = [];
    const messageLocator = targetPage.locator([
      '.el-message:visible',
      '.el-notification:visible',
      '[role="alert"]:visible',
      '.el-form-item__error:visible',
    ].join(', '));
    const messageCount = Math.min(await messageLocator.count().catch(() => 0), 12);
    for (let index = 0; index < messageCount; index += 1) {
      const text = String(await messageLocator.nth(index).innerText().catch(() => '')).trim();
      if (text && !messages.includes(text)) messages.push(text.slice(0, 500));
    }
    return messages;
  };
  try {
    const submitButton = await describeElement(submit);
    const visibleButtons = await describeVisibleElements(
      dialog.locator('button, [role="button"]'),
      20,
    );
    try {
      await submit.scrollIntoViewIfNeeded().catch(() => {});
      // Actionability checks send no click. Only a failure here proves that
      // this invocation did not submit; the real click can throw after dispatch.
      await submit.click({ trial: true, timeout: 5_000 });
    } catch (clickError) {
      const error = new Error(`OMS 批量补发最终提交按钮无法正常点击：${clickError.message}`);
      error.externalEffectStatus = 'failed';
      error.externalEffectReceipt = {
        strategy: 'footer-submit-request-observed-v2',
        clickAttempted: false,
        submitButton,
        visibleButtons,
      };
      throw error;
    }
    try {
      await submit.click({ timeout: 5_000 });
      clickAttempts.push({ attempt: 1, clickedAt });
    } catch (clickError) {
      await Promise.allSettled(responseTasks);
      const error = new Error(`OMS 批量补发点击后结果不确定，禁止重复创建：${clickError.message}`);
      error.externalEffectStatus = 'unknown';
      error.externalEffectReceipt = {
        strategy: 'footer-submit-request-observed-v2',
        clickAttempted: true,
        clickedAt,
        submitButton,
        visibleButtons,
        requests,
        responses,
        nativeDialog,
        confirmationObserved,
        clickError: clickError.message,
      };
      throw error;
    }
    await waitForOutcome(deadline);
    let messages = await collectMessages();
    let formDiagnostic = await inspectOmsFlatBatchReissueForm(dialog);
    const firstAttemptProducedNoEffect = !batchExecution.observed
      && await dialog.isVisible().catch(() => false)
      && !confirmationObserved
      && !nativeDialog
      && requests.length === 0
      && responses.length === 0;
    await Promise.allSettled(responseTasks);
    const observation = {
      strategy: 'footer-submit-request-observed-v2',
      executionStrategy: 'single-order-batch-start-and-terminal-wait-v1',
      clickAttempted: true,
      clickAttempts,
      clickedAt,
      submitButton,
      visibleButtons,
      confirmationObserved,
      confirmationClicked,
      nativeDialog,
      outerDialogVisible: await dialog.isVisible().catch(() => false),
      requests,
      responses,
      messages,
      formDiagnostic,
      batchExecution,
      observedAt: new Date().toISOString(),
    };
    if (batchExecution.observed && batchExecution.failed) {
      const error = new Error(`OMS 订单批量补发执行失败：${batchExecution.failureReason || '执行窗口返回失败'}`);
      error.externalEffectStatus = 'failed';
      error.externalEffectReceipt = observation;
      throw error;
    }
    if (batchExecution.observed && batchExecution.skipped) {
      const error = new Error('OMS 订单批量补发跳过目标订单，已确认未创建补发单');
      error.externalEffectStatus = 'failed';
      error.externalEffectReceipt = observation;
      throw error;
    }
    if (batchExecution.observed && !batchExecution.terminal) {
      const error = new Error('OMS 订单批量补发开始后未在 60 秒内返回终态，结果不确定');
      error.externalEffectReceipt = observation;
      throw error;
    }
    if (observation.outerDialogVisible
      && !observation.confirmationObserved
      && !observation.nativeDialog
      && observation.requests.length === 0) {
      const error = new Error('OMS 批量补发点击后弹窗仍存在且未触发提交请求，已确认本次未提交');
      error.externalEffectStatus = 'failed';
      error.externalEffectReceipt = observation;
      throw error;
    }
    return observation;
  } finally {
    targetPage.off('dialog', onDialog);
    targetPage.off('request', onRequest);
    targetPage.off('response', onResponse);
  }
};
