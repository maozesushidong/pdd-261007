import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { chromium } from 'playwright';
import {
  inspectOmsFlatBatchReissueForm,
  selectOmsReissueReason,
  submitOmsFlatBatchReissue,
} from '../packages/adapters/src/oms/reissue.mjs';

const configuredExecutable = process.env.WORKFLOW_BROWSER_EXECUTABLE_PATH
  || 'C:\\pdd-native\\runtime\\chrome-for-testing\\151.0.7922.34\\chrome.exe';
const browser = await chromium.launch({
  headless: true,
  ...(existsSync(configuredExecutable) ? { executablePath: configuredExecutable } : {}),
});

try {
  const page = await browser.newPage();
  await page.setContent(`
    <div class="el-dialog">
      <div class="el-form-item" data-field="reason">
        <div class="el-form-item__label">补发原因</div>
        <div class="el-form-item__content">
          <div class="el-select" role="combobox" tabindex="0"><input value=""></div>
        </div>
      </div>
      <div class="el-form-item" data-field="custom-one">
        <div class="el-form-item__label">自定义字段1</div>
        <div class="el-form-item__content">
          <div class="el-select" role="combobox" tabindex="0"><input value=""></div>
        </div>
      </div>
    </div>
    <div id="reason-options" role="listbox" hidden>
      <div role="option">快递责任补发</div>
      <div role="option">商家责任补发</div>
    </div>
    <div id="custom-options" role="listbox" hidden><div role="option">无数据</div></div>
    <script>
      const reason = document.querySelector('[data-field="reason"]');
      const custom = document.querySelector('[data-field="custom-one"]');
      reason.querySelector('[role="combobox"]').addEventListener('click', () => {
        document.querySelector('#reason-options').hidden = false;
      });
      custom.querySelector('[role="combobox"]').addEventListener('click', () => {
        document.querySelector('#custom-options').hidden = false;
      });
      document.querySelector('#reason-options [role="option"]').addEventListener('click', (event) => {
        reason.querySelector('input').value = event.currentTarget.textContent;
        document.querySelector('#reason-options').hidden = true;
      });
    </script>
  `);

  assert.equal(await selectOmsReissueReason(page), '快递责任补发');
  assert.equal(await page.locator('[data-field="reason"] input').inputValue(), '快递责任补发');
  assert.equal(await page.locator('[data-field="custom-one"] input').inputValue(), '');
  assert.equal(await page.locator('#custom-options').isVisible(), false);

  const requiredPreflightPage = await browser.newPage();
  await requiredPreflightPage.setContent(`
    <div class="el-dialog" id="required-preflight-dialog">
      <div class="el-form-item is-required" id="required-reason">
        <label class="el-form-item__label">补发原因</label>
        <div class="el-form-item__content"><input value=""></div>
      </div>
      <div class="el-form-item" id="optional-note">
        <label class="el-form-item__label">卖家备注</label>
        <div class="el-form-item__content"><input value=""></div>
      </div>
      <div class="el-dialog__footer"><button id="required-submit">确定</button></div>
    </div>
    <script>
      document.querySelector('#required-submit').addEventListener('click', () => {
        window.requiredSubmitClicks = (window.requiredSubmitClicks || 0) + 1;
      });
    </script>
  `);
  const requiredDialog = requiredPreflightPage.locator('#required-preflight-dialog');
  const incompleteForm = await inspectOmsFlatBatchReissueForm(requiredDialog);
  assert.equal(incompleteForm.valid, false);
  assert.equal(incompleteForm.requiredCount, 1);
  assert.equal(incompleteForm.blockingItems[0]?.label, '补发原因');
  await assert.rejects(
    () => submitOmsFlatBatchReissue(requiredPreflightPage, requiredDialog, {
      timeoutMs: 250,
      pollIntervalMs: 20,
    }),
    (error) => {
      assert.equal(error.externalEffectStatus, 'failed');
      assert.equal(error.externalEffectReceipt?.clickAttempted, false);
      assert.equal(error.externalEffectReceipt?.reason, 'oms-reissue-required-fields-incomplete');
      assert.equal(error.externalEffectReceipt?.formDiagnostic?.blockingItems?.[0]?.label, '补发原因');
      return true;
    },
  );
  assert.equal(
    await requiredPreflightPage.evaluate(() => window.requiredSubmitClicks || 0),
    0,
  );
  await requiredPreflightPage.locator('#required-reason input').fill('快递责任补发');
  const completeForm = await inspectOmsFlatBatchReissueForm(requiredDialog);
  assert.equal(completeForm.valid, true);
  assert.equal(completeForm.requiredItems[0]?.filled, true);

  const domOnlyValuePage = await browser.newPage();
  await domOnlyValuePage.setContent(`
    <div class="el-dialog" id="dom-only-dialog">
      <div class="el-form-item is-required" id="dom-only-reason">
        <label class="el-form-item__label">补发原因</label>
        <div class="el-form-item__content"><input value="快递责任补发"></div>
      </div>
      <div class="el-dialog__footer"><button>确定</button></div>
    </div>
    <script>
      document.querySelector('#dom-only-reason input')._value = '';
    </script>
  `);
  const domOnlyDialog = domOnlyValuePage.locator('#dom-only-dialog');
  const domOnlyForm = await inspectOmsFlatBatchReissueForm(domOnlyDialog);
  assert.equal(domOnlyForm.valid, false);
  assert.equal(domOnlyForm.blockingItems[0]?.filled, true);
  assert.equal(domOnlyForm.blockingItems[0]?.invalid, true);
  assert.equal(
    domOnlyForm.blockingItems[0]?.controlStates?.some((state) => (
      state.domValuePresent
      && state.vueBoundValueObserved
      && state.domMatchesVueBoundValue === false
    )),
    true,
  );

  const delayedPage = await browser.newPage();
  await delayedPage.setContent(`
    <div id="unrelated"><div role="combobox"><input value=""></div></div>
    <div id="reason-field"><span class="reason-label">业务类型：</span></div>
    <div id="delayed-options" role="listbox" hidden>
      <div role="option">快递责任补发</div>
    </div>
    <script>
      const reasonField = document.querySelector('#reason-field');
      setTimeout(() => {
        const content = document.createElement('div');
        content.className = 'custom-control';
        content.innerHTML = '<div role="combobox" tabindex="0"><input value=""></div>';
        reasonField.appendChild(content);
        content.querySelector('[role="combobox"]').addEventListener('click', () => {
          document.querySelector('#delayed-options').hidden = false;
        });
      }, 100);
      document.querySelector('#delayed-options [role="option"]').addEventListener('click', (event) => {
        const selectedText = event.currentTarget.textContent;
        setTimeout(() => {
          reasonField.querySelector('input').value = selectedText;
        }, 120);
        document.querySelector('#delayed-options').hidden = true;
      });
    </script>
  `);
  assert.equal(await selectOmsReissueReason(delayedPage, '快递责任补发', {
    timeoutMs: 1_000,
    pollIntervalMs: 20,
  }), '快递责任补发');
  assert.equal(await delayedPage.locator('#reason-field input').inputValue(), '快递责任补发');
  assert.equal(await delayedPage.locator('#unrelated input').inputValue(), '');

  const customPickerPage = await browser.newPage();
  await customPickerPage.setContent(`
    <div class="el-form-item" id="custom-picker-field">
      <div class="el-form-item__label-wrap"><label class="el-form-item__label">补发原因</label></div>
      <div class="el-form-item__content">
        <div class="el-input select-base-input"><input readonly value=""></div>
      </div>
    </div>
    <div class="el-dialog data-dict-item-selector-popper-class" hidden>
      <table><tbody><tr><td><div class="cell el-tooltip">快递责任补发</div></td></tr></tbody></table>
      <button disabled>确定</button>
    </div>
    <script>
      const field = document.querySelector('#custom-picker-field');
      const picker = document.querySelector('.data-dict-item-selector-popper-class');
      const row = picker.querySelector('tr');
      const confirm = picker.querySelector('button');
      field.querySelector('.select-base-input').addEventListener('click', () => {
        picker.hidden = false;
      });
      row.addEventListener('click', () => {
        row.classList.add('current-row');
        confirm.disabled = false;
      });
      confirm.addEventListener('click', () => {
        field.querySelector('input').value = row.textContent.trim();
        picker.hidden = true;
      });
    </script>
  `);
  assert.equal(await selectOmsReissueReason(customPickerPage, '快递责任补发', {
    timeoutMs: 1_000,
    pollIntervalMs: 20,
  }), '快递责任补发');
  assert.equal(await customPickerPage.locator('#custom-picker-field input').inputValue(), '快递责任补发');
  assert.equal(await customPickerPage.locator('.data-dict-item-selector-popper-class').isVisible(), false);

  const doubleClickPickerPage = await browser.newPage();
  await doubleClickPickerPage.setContent(`
    <div class="el-form-item is-required is-error" id="double-click-picker-field">
      <label class="el-form-item__label">补发原因</label>
      <div class="el-form-item__content">
        <div class="el-input select-base-input"><input readonly value=""></div>
        <div class="el-form-item__error">不能为空</div>
      </div>
    </div>
    <div class="el-dialog data-dict-item-selector-popper-class" hidden>
      <table><tbody><tr><td>507</td><td><div class="cell el-tooltip">快递责任补发</div></td></tr></tbody></table>
    </div>
    <script>
      const field = document.querySelector('#double-click-picker-field');
      const picker = document.querySelector('.data-dict-item-selector-popper-class');
      const row = picker.querySelector('tr');
      const input = field.querySelector('input');
      input._value = '';
      field.querySelector('.select-base-input').addEventListener('click', () => {
        picker.hidden = false;
      });
      row.addEventListener('click', () => {
        row.classList.add('current-row');
        input.value = '快递责任补发';
      });
      row.addEventListener('dblclick', () => {
        input.value = '快递责任补发';
        input._value = '快递责任补发';
        field.classList.remove('is-error');
        field.querySelector('.el-form-item__error').remove();
        picker.hidden = true;
      });
    </script>
  `);
  assert.equal(await selectOmsReissueReason(doubleClickPickerPage, '快递责任补发', {
    timeoutMs: 4_000,
    pollIntervalMs: 20,
  }), '快递责任补发');
  assert.equal(
    await doubleClickPickerPage.locator('#double-click-picker-field input').inputValue(),
    '快递责任补发',
  );
  assert.equal(
    await doubleClickPickerPage.locator('.data-dict-item-selector-popper-class').isVisible(),
    false,
  );
  const doubleClickCommittedForm = await inspectOmsFlatBatchReissueForm(
    doubleClickPickerPage.locator('body'),
  );
  assert.equal(doubleClickCommittedForm.valid, true);
  assert.equal(doubleClickCommittedForm.requiredItems[0]?.invalid, false);
  assert.equal(
    doubleClickCommittedForm.requiredItems[0]?.controlStates?.some((state) => (
      state.domValuePresent
      && state.vueBoundValueObserved
      && state.domMatchesVueBoundValue === true
    )),
    true,
  );

  const reopenAfterDomOnlyPage = await browser.newPage();
  await reopenAfterDomOnlyPage.setContent(`
    <div class="el-form-item is-required is-error" id="reopen-dom-only-field">
      <label class="el-form-item__label">补发原因</label>
      <div class="el-form-item__content">
        <div class="el-input select-base-input"><input readonly value=""></div>
        <div class="el-form-item__error">不能为空</div>
      </div>
    </div>
    <div class="el-dialog data-dict-item-selector-popper-class" hidden>
      <table><tbody><tr><td>507</td><td>快递责任补发</td></tr></tbody></table>
    </div>
    <script>
      const field = document.querySelector('#reopen-dom-only-field');
      const picker = document.querySelector('.data-dict-item-selector-popper-class');
      const row = picker.querySelector('tr');
      const input = field.querySelector('input');
      let openCount = 0;
      input._value = '';
      field.querySelector('.select-base-input').addEventListener('click', () => {
        openCount += 1;
        window.reopenDomOnlyOpenCount = openCount;
        picker.hidden = false;
      });
      row.addEventListener('click', () => {
        input.value = '快递责任补发';
        if (openCount === 1) picker.hidden = true;
      });
      row.addEventListener('dblclick', () => {
        input.value = '快递责任补发';
        input._value = '快递责任补发';
        field.classList.remove('is-error');
        field.querySelector('.el-form-item__error')?.remove();
        picker.hidden = true;
      });
    </script>
  `);
  assert.equal(await selectOmsReissueReason(reopenAfterDomOnlyPage, '快递责任补发', {
    timeoutMs: 5_000,
    pollIntervalMs: 20,
  }), '快递责任补发');
  assert.equal(
    await reopenAfterDomOnlyPage.evaluate(() => window.reopenDomOnlyOpenCount),
    2,
  );
  const reopenedCommittedForm = await inspectOmsFlatBatchReissueForm(
    reopenAfterDomOnlyPage.locator('body'),
  );
  assert.equal(reopenedCommittedForm.valid, true);
  assert.equal(reopenedCommittedForm.requiredItems[0]?.invalid, false);

  const stickyPickerPage = await browser.newPage();
  await stickyPickerPage.setContent(`
    <div class="el-form-item" id="sticky-picker-field">
      <label class="el-form-item__label">业务类型</label>
      <div class="el-form-item__content">
        <div class="el-input select-base-input"><input readonly value=""></div>
      </div>
    </div>
    <div class="el-dialog data-dict-item-selector-popper-class" hidden>
      <table><tbody><tr><td>507</td><td>快递责任补发</td></tr></tbody></table>
    </div>
    <script>
      const field = document.querySelector('#sticky-picker-field');
      const picker = document.querySelector('.data-dict-item-selector-popper-class');
      const row = picker.querySelector('tr');
      field.querySelector('.select-base-input').addEventListener('click', () => {
        picker.hidden = false;
      });
      row.addEventListener('click', () => {
        field.querySelector('input').value = '快递责任补发';
      });
      row.addEventListener('dblclick', () => {
        picker.hidden = true;
      });
    </script>
  `);
  assert.equal(await selectOmsReissueReason(stickyPickerPage, '快递责任补发', {
    timeoutMs: 4_000,
    pollIntervalMs: 20,
  }), '快递责任补发');
  assert.equal(
    await stickyPickerPage.locator('#sticky-picker-field input').inputValue(),
    '快递责任补发',
  );
  assert.equal(
    await stickyPickerPage.locator('.data-dict-item-selector-popper-class').isVisible(),
    false,
  );

  const delayedConfirmationPage = await browser.newPage();
  await delayedConfirmationPage.setContent(`
    <div class="el-dialog" id="batch-reissue-dialog">
      <div>批量补发</div>
      <button id="decoy-submit">确定</button>
      <div class="el-dialog__footer">
        <button id="outer-submit">确定</button>
      </div>
    </div>
    <div class="el-message-box" role="alertdialog" hidden>
      <div>确认创建补发单？</div>
      <button id="delayed-confirm">确定</button>
    </div>
    <script>
      const outer = document.querySelector('#batch-reissue-dialog');
      const confirmation = document.querySelector('.el-message-box');
      document.querySelector('#decoy-submit').addEventListener('click', () => {
        window.decoySubmitClicked = (window.decoySubmitClicked || 0) + 1;
      });
      document.querySelector('#outer-submit').addEventListener('click', () => {
        setTimeout(() => { confirmation.hidden = false; }, 150);
      });
      document.querySelector('#delayed-confirm').addEventListener('click', () => {
        window.reissueSubmitConfirmed = (window.reissueSubmitConfirmed || 0) + 1;
        confirmation.hidden = true;
        outer.hidden = true;
      });
    </script>
  `);
  const delayedObservation = await submitOmsFlatBatchReissue(
    delayedConfirmationPage,
    delayedConfirmationPage.locator('#batch-reissue-dialog'),
    { timeoutMs: 2_000, pollIntervalMs: 20 },
  );
  assert.equal(delayedObservation.confirmationObserved, true);
  assert.equal(delayedObservation.confirmationClicked, true);
  assert.equal(delayedObservation.outerDialogVisible, false);
  assert.equal(await delayedConfirmationPage.evaluate(() => window.reissueSubmitConfirmed), 1);
  assert.equal(await delayedConfirmationPage.evaluate(() => window.decoySubmitClicked || 0), 0);
  assert.equal(delayedObservation.submitButton?.attributes?.id, 'outer-submit');

  const batchExecutionPage = await browser.newPage();
  await batchExecutionPage.setContent(`
    <div class="el-dialog" id="batch-form-dialog">
      <div>批量补发</div>
      <div class="el-form-item is-required">
        <label class="el-form-item__label">补发原因</label>
        <div class="el-form-item__content"><input value="快递责任补发"></div>
      </div>
      <div class="el-dialog__footer"><button id="open-batch-execution">确定</button></div>
    </div>
    <div class="el-overlay" id="batch-execution-overlay" hidden>
      <div class="el-dialog" role="dialog" id="batch-execution-dialog">
        <header><span>订单批量补发</span><button aria-label="关闭此对话框">X</button></header>
        <div id="batch-row">260822-371762153000016 未开始 取消</div>
        <div id="batch-summary">0% 当前第 0 条，共 1 条 成功 0 条，失败 0 条，跳过 1 条</div>
        <footer><button id="batch-start">开始</button><button>取消</button></footer>
      </div>
    </div>
    <script>
      const form = document.querySelector('#batch-form-dialog');
      const overlay = document.querySelector('#batch-execution-overlay');
      document.querySelector('#open-batch-execution').addEventListener('click', () => {
        overlay.hidden = false;
      });
      document.querySelector('#batch-start').addEventListener('click', () => {
        window.batchExecutionStartClicks = (window.batchExecutionStartClicks || 0) + 1;
        document.querySelector('#batch-row').textContent = '260822-371762153000016 进行中';
        document.querySelector('#batch-summary').textContent =
          '50% 当前第 1 条，共 1 条 成功 0 条，失败 0 条，跳过 0 条';
        setTimeout(() => {
          document.querySelector('#batch-row').textContent = '260822-371762153000016 成功';
          document.querySelector('#batch-summary').textContent =
            '100% 当前第 1 条，共 1 条 成功 1 条，失败 0 条，跳过 0 条';
        }, 60);
      });
      document.querySelector('[aria-label="关闭此对话框"]').addEventListener('click', () => {
        overlay.hidden = true;
        form.hidden = true;
      });
    </script>
  `);
  const batchExecutionObservation = await submitOmsFlatBatchReissue(
    batchExecutionPage,
    batchExecutionPage.locator('#batch-form-dialog'),
    {
      orderNumber: '260822-371762153000016',
      timeoutMs: 2_000,
      pollIntervalMs: 20,
    },
  );
  assert.equal(batchExecutionObservation.batchExecution.observed, true);
  assert.equal(batchExecutionObservation.batchExecution.orderMatched, true);
  assert.equal(batchExecutionObservation.batchExecution.singleOrder, true);
  assert.equal(batchExecutionObservation.batchExecution.startClicked, true);
  assert.equal(batchExecutionObservation.batchExecution.terminal, true);
  assert.equal(batchExecutionObservation.batchExecution.succeeded, true);
  assert.equal(batchExecutionObservation.clickAttempts.length, 2);
  assert.equal(batchExecutionObservation.clickAttempts[1]?.action, 'batch-execution-start');
  assert.equal(
    await batchExecutionPage.evaluate(() => window.batchExecutionStartClicks || 0),
    1,
  );
  assert.equal(await batchExecutionPage.locator('#batch-execution-overlay').isVisible(), false);

  const inertSubmitPage = await browser.newPage();
  await inertSubmitPage.setContent(`
    <div class="el-dialog" id="inert-batch-dialog">
      <div>批量补发</div>
      <div class="el-dialog__footer"><button id="inert-submit">确定</button></div>
    </div>
  `);
  await assert.rejects(
    () => submitOmsFlatBatchReissue(
      inertSubmitPage,
      inertSubmitPage.locator('#inert-batch-dialog'),
      { timeoutMs: 250, pollIntervalMs: 20 },
    ),
    (error) => {
      assert.equal(error.externalEffectStatus, 'failed');
      assert.equal(error.externalEffectReceipt?.clickAttempted, true);
      assert.equal(error.externalEffectReceipt?.outerDialogVisible, true);
      assert.deepEqual(error.externalEffectReceipt?.requests, []);
      assert.match(error.message, /未触发提交请求/u);
      return true;
    },
  );

  const nativeConfirmationPage = await browser.newPage();
  await nativeConfirmationPage.setContent(`
    <div class="el-dialog" id="native-batch-dialog">
      <div>批量补发</div>
      <button id="native-submit">确定</button>
    </div>
    <script>
      const outer = document.querySelector('#native-batch-dialog');
      document.querySelector('#native-submit').addEventListener('click', () => {
        if (confirm('是否确认创建补发单？')) {
          window.nativeReissueConfirmed = true;
          outer.hidden = true;
        }
      });
    </script>
  `);
  const nativeObservation = await submitOmsFlatBatchReissue(
    nativeConfirmationPage,
    nativeConfirmationPage.locator('#native-batch-dialog'),
    { timeoutMs: 2_000, pollIntervalMs: 20 },
  );
  assert.equal(nativeObservation.nativeDialog?.type, 'confirm');
  assert.equal(nativeObservation.outerDialogVisible, false);
  assert.equal(await nativeConfirmationPage.evaluate(() => window.nativeReissueConfirmed), true);
  console.log('OMS reissue reason UI self-test passed');
} finally {
  await browser.close();
}
