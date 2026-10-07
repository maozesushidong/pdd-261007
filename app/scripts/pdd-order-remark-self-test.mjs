import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  addPddOrderRemark,
  inspectPddOrderRemark,
  isDismissiblePddMarketingBlocker,
  shouldFallbackFromPddOrderRemarkVerification,
} from '../packages/adapters/src/pdd/order-remark.mjs';

assert.equal(isDismissiblePddMarketingBlocker({
  className: 'mms-header__open-item',
  text: '跨境电商 TEMU 网格仓/服务站招募',
}), true);
assert.equal(isDismissiblePddMarketingBlocker({
  className: 'mms-header__open-item',
  text: '确认退款处理结果',
}), false, 'a business popup must never use the marketing-menu dismissal path');
assert.equal(isDismissiblePddMarketingBlocker({
  className: 'beast-core-modal',
  text: '安全验证 请完成拼图',
}), false, 'verification must never use the marketing-menu dismissal path');

assert.equal(shouldFallbackFromPddOrderRemarkVerification({
  orderNumber: '260820-100000000000001',
  remark: {
    orderNumber: '260820-100000000000001',
    status: 'starting',
    verificationChallenges: 1,
  },
}), true);
assert.equal(shouldFallbackFromPddOrderRemarkVerification({
  orderNumber: '260820-100000000000001',
  remark: {
    orderNumber: '260820-100000000000001',
    status: 'saved',
    verificationChallenges: 3,
  },
}), false);
assert.equal(shouldFallbackFromPddOrderRemarkVerification({
  orderNumber: '260820-100000000000001',
  remark: { orderNumber: '260820-100000000000002', status: 'starting' },
  verificationStage: 'pdd-order-remark-detail',
}), false);
assert.equal(shouldFallbackFromPddOrderRemarkVerification({
  orderNumber: '260820-100000000000001',
  remark: { orderNumber: '260820-100000000000001', status: 'starting' },
  verificationStage: 'pdd-order-remark-detail',
}), true);
import { detectHumanVerification } from '../packages/adapters/src/verification-detector/detect.mjs';

const orderNumber = '260729186153777480';
const wrongOrderNumber = '260730999999999999';

const remarkEditorMarkup = ({ includeRed = true } = {}) => `
  <div class="remark-colors">
    ${includeRed ? '<button data-color="红色" onclick="selectRemarkColor(this)">红色</button>' : ''}
    <button data-color="黄色" onclick="selectRemarkColor(this)">黄色</button>
  </div>
  <div data-selected-color></div>
  <textarea placeholder="请输入备注"></textarea>
  <button onclick="saveRemark(this)">保存</button>
  <button onclick="closeRemark(this)">取消</button>`;

const remarkFunctions = (documentExpression = 'document', silentSave = false) => `
  function selectRemarkColor(button) {
    const dialog = button.closest('[role=dialog]');
    window.remarkColorClicks = Number(window.remarkColorClicks || 0) + 1;
    const attempts = Number(dialog.dataset.colorSelectionAttempts || 0) + 1;
    dialog.dataset.colorSelectionAttempts = String(attempts);
    if (dialog.dataset.transientColorRerender === 'true' && attempts === 1) {
      button.replaceWith(button.cloneNode(true));
      return;
    }
    dialog.querySelectorAll('[data-color]').forEach((candidate) => candidate.classList.remove('selected'));
    button.classList.add('selected');
    dialog.querySelector('[data-selected-color]').textContent = button.dataset.color;
  }
  function closeRemark(button) {
    button.closest('[role=dialog]').remove();
  }
  function saveRemark(button) {
    const dialog = button.closest('[role=dialog]');
    const selectedColor = dialog.querySelector('[data-selected-color]').textContent;
    if (!selectedColor) return;
    const result = ${documentExpression}.getElementById('result');
    result.dataset.savedColor = selectedColor;
    result.textContent = ${silentSave ? "''" : "'备注保存成功 ' + selectedColor + ' ' + dialog.querySelector('textarea').value"};
    dialog.remove();
  }`;

const remarkEntryMarkup = (remarkLabel, entryKind = 'button', disabled = false) => {
  if (entryKind === 'link') {
    return `<a href="#" onclick="event.preventDefault(); openRemark()">${remarkLabel}</a>`;
  }
  if (entryKind === 'role-button') {
    return `<div role="button" tabindex="0" onclick="openRemark()">${remarkLabel}</div>`;
  }
  return `<button ${disabled ? 'disabled' : ''} onclick="openRemark()">${remarkLabel}</button>`;
};

const detailMarkup = ({
  includeRemark = true,
  includeRed = true,
  remarkLabel = '添加备注',
  entryKind = 'button',
  remarkDelayMs = 0,
  order = orderNumber,
  existingRemark = '',
  entryDisabled = false,
  includeScript = true,
} = {}) => {
  const entryMarkup = remarkEntryMarkup(remarkLabel, entryKind, entryDisabled);
  return `
  <article data-order-detail>
    <h1>订单详情</h1><div>订单编号</div><strong>${order}</strong><div>商品信息</div>
    ${includeRemark
    ? remarkDelayMs > 0 ? '<div id="delayed-remark-entry"></div>' : entryMarkup
    : '<div>订单备注不可用</div>'}
    <div id="result">${existingRemark}</div>
  </article>
  ${includeScript ? `<script>
    function openRemark() {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.innerHTML = ${JSON.stringify(remarkEditorMarkup({ includeRed }))};
      document.body.appendChild(dialog);
    }
    ${remarkFunctions()}
    ${remarkDelayMs > 0 ? `setTimeout(() => {
      document.getElementById('delayed-remark-entry').innerHTML = ${JSON.stringify(entryMarkup)};
    }, ${remarkDelayMs});` : ''}
  </script>` : ''}`;
};

const embeddedDetailMarkup = detailMarkup({ includeScript: false });
const modifiedEmbeddedDetailMarkup = detailMarkup({ includeScript: false, remarkLabel: '修改备注' });

const blockingOverlayMarkup = (mode) => {
  if (mode === 'safe-guide') {
    return `<div data-testid="beast-core-modal" class="onboarding-guide blocking-overlay" role="dialog">
      <div>新手引导</div><div>功能介绍与操作指引</div>
      <button data-testid="beast-core-modal-close-button" aria-label="关闭"
        onclick="window.safeGuideClosed=true; this.closest('[role=dialog]').remove()">X</button>
    </div>`;
  }
  if (mode === 'verification-overlay') {
    return `<div data-testid="beast-core-modal" class="blocking-overlay" role="dialog">
      <div data-testid="beast-core-modal-container">
        <img alt="" style="width:180px;height:80px" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
        <div class="puzzle-slider" style="width:180px;height:28px"><div class="drag-handle" style="width:28px;height:28px"></div></div>
      </div>
      <button data-testid="beast-core-modal-close-button" aria-label="关闭"
        onclick="window.verificationCloseClicked=true; this.closest('[role=dialog]').remove()">X</button>
    </div>`;
  }
  if (mode === 'business-modal') {
    return `<div data-testid="beast-core-modal" class="blocking-overlay" role="dialog">
      <div>确认退款处理结果</div>
      <button data-testid="beast-core-modal-close-button" aria-label="关闭"
        onclick="window.businessModalClosed=true; this.closest('[role=dialog]').remove()">X</button>
    </div>`;
  }
  if (mode === 'marketing-dropdown') {
    return `<div class="mms-header__open-item blocking-overlay">
      <div>跨境电商</div><div>TEMU</div><div>网格仓/服务站招募</div>
    </div>`;
  }
  return '';
};

const baseMarkup = (mode) => {
  const embeddedMarkup = mode === 'modify'
    ? modifiedEmbeddedDetailMarkup
    : mode === 'inspect-existing'
      ? detailMarkup({ includeScript: false, remarkLabel: '修改备注', existingRemark: '自动化' })
      : mode === 'disabled-existing'
        ? detailMarkup({ includeScript: false, remarkLabel: '修改备注', existingRemark: '自动化', entryDisabled: true })
      : mode === 'disabled-entry' || mode === 'verification-during-entry'
          ? detailMarkup({ includeScript: false, entryDisabled: true })
      : embeddedDetailMarkup;
  return `
  <style>.blocking-overlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;flex-direction:column}</style>
  ${blockingOverlayMarkup(mode)}
  ${mode === 'sticky-header' ? '<div class="mms-header__list" style="position:fixed;z-index:1000;top:0;left:0;right:0;height:160px;background:#fff">顶部菜单</div>' : ''}
  <section><h2>售后信息</h2><button id="wrong" onclick="window.wrongClicked=true">查看详情</button></section>
  <section id="order-info-section"><h2>订单信息</h2><div>订单编号 ${orderNumber}</div>${mode === 'delayed-detail-action' ? '<span id="delayed-detail-action">详情入口加载中</span>' : '<button id="correct" onclick="openDetail()">查看详情</button>'}</section>
  <div id="source-status">待处理</div>
  <button>提交</button>
  <script>
    window.wrongClicked = false;
    window.safeGuideClosed = false;
    window.verificationCloseClicked = false;
    window.businessModalClosed = false;
    window.marketingMenuDismissed = false;
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const menu = document.querySelector('.mms-header__open-item');
      if (!menu) return;
      window.marketingMenuDismissed = true;
      menu.remove();
    });
    ${mode === 'delayed-detail-action' ? `setTimeout(() => {
      const button = document.createElement('button');
      button.id = 'correct';
      button.textContent = '查看详情';
      button.onclick = openDetail;
      document.getElementById('delayed-detail-action').replaceWith(button);
    }, 1200);` : ''}
    ${mode === 'sticky-header' ? `
      document.body.style.minHeight = '1600px';
      document.getElementById('order-info-section').style.marginTop = '400px';
      window.scrollTo(0, 400);
    ` : ''}
    ${mode === 'verification-on-scroll' ? `
      document.getElementById('correct').closest('section').style.marginTop = '1600px';
      window.addEventListener('scroll', () => {
        if (document.querySelector('[data-testid="beast-core-modal"]')) return;
        const overlay = document.createElement('div');
        overlay.dataset.testid = 'beast-core-modal';
        overlay.className = 'blocking-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.innerHTML = '<div data-testid="beast-core-modal-container">请向右滑块完成拼图</div><button data-testid="beast-core-modal-close-button" onclick="window.verificationCloseClicked=true;this.parentElement.remove()">X</button>';
        document.body.appendChild(overlay);
      }, { once: true });
    ` : ''}
    function openRemark() {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      if (new URLSearchParams(location.search).get('mode') === 'color-rerender') {
        dialog.dataset.transientColorRerender = 'true';
      }
      dialog.innerHTML = ${JSON.stringify(remarkEditorMarkup())};
      document.body.appendChild(dialog);
    }
    ${remarkFunctions('document', mode === 'silent-save')}
    function openDetail() {
      const mode = ${JSON.stringify(mode)};
      if (mode === 'popup') window.open('http://remark.test/detail');
      if (mode === 'popup-refresh') window.open('http://remark.test/orders/detail?sn=${orderNumber}&mode=refresh');
      if (mode === 'popup-refresh-timeout') window.open('http://remark.test/orders/detail?sn=${orderNumber}&mode=refresh-timeout');
      if (mode === 'popup-refresh-aborted') window.open('http://remark.test/orders/detail?sn=${orderNumber}&mode=refresh-aborted');
      if (mode === 'popup-blank') window.open('http://remark.test/orders/detail?sn=${orderNumber}&mode=blank');
      if (mode === 'popup-verification') window.open('http://remark.test/verification?popup=1');
      if (mode === 'current-page') location.href = 'http://remark.test/detail';
      if (mode === 'delayed-entry') location.href = 'http://remark.test/detail?remark=delayed';
      if (mode === 'link-entry') location.href = 'http://remark.test/detail?entry=link';
      if (mode === 'role-button-entry') location.href = 'http://remark.test/detail?entry=role-button';
      if (mode === 'not-available') location.href = 'http://remark.test/detail?remark=none';
      if (mode === 'no-red') location.href = 'http://remark.test/detail?color=none';
      if (mode === 'wrong-order') location.href = 'http://remark.test/detail?order=wrong';
      if (mode === 'wrong-order-once') {
        const opened = Number(sessionStorage.getItem('wrong-order-open-count') || '0');
        sessionStorage.setItem('wrong-order-open-count', String(opened + 1));
        location.href = opened === 0
          ? 'http://remark.test/detail?order=wrong'
          : 'http://remark.test/detail';
      }
      if (mode === 'blank') location.href = 'http://remark.test/blank';
      if (mode === 'login') location.href = 'http://remark.test/login';
      if (mode === 'verification') location.href = 'http://remark.test/verification';
      if (mode === 'verification-refresh') location.href = 'http://remark.test/verification';
      if (mode === 'source-text-change') setTimeout(() => {
        document.getElementById('source-status').textContent = '页面数据已更新';
      }, 30);
      if (mode === 'drawer' || mode === 'modal' || mode === 'modify' || mode === 'silent-save' || mode === 'inspect-existing'
        || mode === 'verification-on-scroll'
        || mode === 'safe-guide' || mode === 'verification-overlay' || mode === 'business-modal'
        || mode === 'marketing-dropdown'
        || mode === 'disabled-existing' || mode === 'disabled-entry'
        || mode === 'verification-during-entry'
        || mode === 'sticky-header' || mode === 'delayed-detail-action'
        || mode === 'color-rerender') {
        const container = document.createElement('div');
        if (mode !== 'modal') container.className = 'ant-drawer';
        else container.setAttribute('role', 'dialog');
        container.innerHTML = ${JSON.stringify(embeddedMarkup)};
        document.body.appendChild(container);
        if (mode === 'verification-during-entry') setTimeout(() => {
          const overlay = document.createElement('div');
          overlay.dataset.testid = 'beast-core-modal';
          overlay.className = 'blocking-overlay';
          overlay.setAttribute('role', 'dialog');
          overlay.innerHTML = '<div data-testid="beast-core-modal-container">请向右滑块完成拼图</div>';
          document.body.appendChild(overlay);
        }, 300);
      }
      if (mode === 'iframe') {
        const frame = document.createElement('iframe');
        frame.srcdoc = ${JSON.stringify(embeddedDetailMarkup)};
        frame.onload = () => {
          const doc = frame.contentDocument;
          frame.contentWindow.openRemark = () => {
            const dialog = doc.createElement('div');
            dialog.setAttribute('role', 'dialog');
            dialog.innerHTML = ${JSON.stringify(remarkEditorMarkup())};
            doc.body.appendChild(dialog);
          };
          frame.contentWindow.eval(${JSON.stringify(remarkFunctions())});
        };
        document.body.appendChild(frame);
      }
    }
  </script>`;
};

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
try {
  const context = await browser.newContext();
  let refreshDetailRequests = 0;
  let timeoutRefreshDetailRequests = 0;
  let abortedRefreshDetailRequests = 0;
  await context.route('http://remark.test/**', async (route) => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname === '/detail') {
      body = detailMarkup({
        includeRemark: url.searchParams.get('remark') !== 'none',
        includeRed: url.searchParams.get('color') !== 'none',
        remarkDelayMs: url.searchParams.get('remark') === 'delayed' ? 120 : 0,
        entryKind: url.searchParams.get('entry') || 'button',
        order: url.searchParams.get('order') === 'wrong' ? wrongOrderNumber : orderNumber,
      });
    } else if (url.pathname === '/orders/detail') {
      if (url.searchParams.get('mode') === 'refresh') refreshDetailRequests++;
      if (url.searchParams.get('mode') === 'refresh-timeout') timeoutRefreshDetailRequests++;
      if (url.searchParams.get('mode') === 'refresh-aborted') abortedRefreshDetailRequests++;
      body = (url.searchParams.get('mode') === 'refresh' && refreshDetailRequests > 1)
        || (url.searchParams.get('mode') === 'refresh-timeout' && timeoutRefreshDetailRequests > 1)
        || (url.searchParams.get('mode') === 'refresh-aborted' && abortedRefreshDetailRequests > 1)
        ? detailMarkup()
        : '<div>加载中</div>';
    } else if (url.pathname === '/captcha-frame') {
      body = '<div class="captcha-widget"><div role="slider">向右滑动</div></div>';
    } else if (url.pathname === '/login') {
      body = '<h1>账号登录</h1><input placeholder="请输入账号名">';
    } else if (url.pathname === '/verification') {
      body = '<h1>安全验证</h1><div>请向右滑动完成拼图</div>';
    } else if (url.pathname === '/blank') {
      body = '<div>加载中</div>';
    } else {
      body = baseMarkup(url.searchParams.get('mode') || 'drawer');
    }
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  });

  const run = async (mode, options = {}) => {
    const page = await context.newPage();
    await page.goto(`http://remark.test/work-order?mode=${encodeURIComponent(mode)}`);
    let saveCalls = 0;
    let detailOpenCalls = 0;
    let detailRefreshCalls = 0;
    let result;
    try {
      result = await addPddOrderRemark({
        targetPage: page,
        orderNumber,
        popupTimeoutMs: 300,
        timeoutMs: 1_500,
        pollMs: 20,
        settleMs: 50,
        onVerification: options.onVerification,
        action: async (name, callback) => {
          if (name === 'open-order-info-detail') detailOpenCalls++;
          if (name === 'refresh-order-info-detail') detailRefreshCalls++;
          if (name === 'refresh-order-info-detail' && options.detailRefreshError) {
            await callback();
            throw new Error(options.detailRefreshError);
          }
          if (name === 'open-order-info-detail'
            && options.failFirstDetailClick
            && detailOpenCalls === 1) {
            throw new Error('locator.click: Timeout 1500ms exceeded');
          }
          return callback();
        },
        guardSave: async (callback) => {
          saveCalls++;
          if (options.alreadySucceeded) return { alreadySucceeded: true };
          return { result: await callback(), alreadySucceeded: false };
        },
      });
    } catch (error) {
      console.error('remark-test-debug', mode, page.url(), await page.locator('body').innerText().catch(() => ''));
      throw error;
    }
    return { page, result, saveCalls, detailOpenCalls, detailRefreshCalls };
  };

  for (const [mode, expectedMode] of [
    ['current-page', 'current-page'],
    ['popup', 'popup'],
    ['drawer', 'drawer'],
    ['modal', 'modal'],
    ['iframe', 'iframe'],
    ['modify', 'drawer'],
    ['silent-save', 'drawer'],
    ['delayed-entry', 'current-page'],
    ['link-entry', 'current-page'],
    ['role-button-entry', 'current-page'],
    ['delayed-detail-action', 'drawer'],
  ]) {
    let execution;
    try {
      execution = await run(mode);
    } catch (error) {
      error.message = `${mode}: ${error.message}`;
      throw error;
    }
    const { page, result, saveCalls } = execution;
    assert.equal(result.remarkStatus, 'saved', `${mode} should save the remark`);
    assert.equal(result.remarkColor, '红色');
    assert.equal(result.detailMode, expectedMode);
    assert.equal(saveCalls, 1);
    assert.match(page.url(), /\/work-order/);
    if (mode === 'drawer') assert.equal(await page.evaluate(() => window.wrongClicked), false, 'must not click after-sales detail');
    await page.close();
  }

  const colorRerender = await run('color-rerender');
  assert.equal(colorRerender.result.remarkStatus, 'saved');
  assert.equal(colorRerender.saveCalls, 1, 'a transient color re-render must still save only once');
  assert.equal(await colorRerender.page.evaluate(() => window.remarkColorClicks), 2,
    'the detached color selection must be re-resolved and retried once');
  await colorRerender.page.close();

  const popupRefresh = await run('popup-refresh');
  assert.equal(popupRefresh.result.remarkStatus, 'saved');
  assert.equal(popupRefresh.result.detailMode, 'popup');
  assert.equal(popupRefresh.detailOpenCalls, 1, 'a slow popup must be opened only once before refresh');
  assert.equal(popupRefresh.detailRefreshCalls, 1, 'a slow popup must refresh the existing tab once');
  assert.equal(refreshDetailRequests, 2, 'the refreshed popup should request the same detail URL twice');
  assert.equal(context.pages().filter((candidate) => /\/orders\/detail/.test(candidate.url())).length, 0,
    'the successful popup must close after remark processing');
  await popupRefresh.page.close();

  const popupRefreshTimeout = await run('popup-refresh-timeout', {
    detailRefreshError: 'page.reload: Timeout 1500ms exceeded.',
  });
  assert.equal(popupRefreshTimeout.result.remarkStatus, 'saved');
  assert.equal(popupRefreshTimeout.result.detailMode, 'popup');
  assert.equal(popupRefreshTimeout.detailOpenCalls, 1,
    'a reload timeout after navigation must not reopen the popup');
  assert.equal(popupRefreshTimeout.detailRefreshCalls, 1,
    'a reload timeout after navigation must keep the refresh bounded');
  assert.equal(timeoutRefreshDetailRequests, 2,
    'a timed-out reload must still inspect the refreshed detail response');
  await popupRefreshTimeout.page.close();

  const popupRefreshAborted = await run('popup-refresh-aborted', {
    detailRefreshError: 'page.reload: net::ERR_ABORTED; maybe frame was detached?',
  });
  assert.equal(popupRefreshAborted.result.remarkStatus, 'saved');
  assert.equal(popupRefreshAborted.result.detailMode, 'popup');
  assert.equal(popupRefreshAborted.detailOpenCalls, 1,
    'an aborted SPA reload must not reopen the popup');
  assert.equal(popupRefreshAborted.detailRefreshCalls, 1,
    'an aborted SPA reload must keep the refresh bounded');
  assert.equal(abortedRefreshDetailRequests, 2,
    'an aborted SPA reload must still inspect the refreshed detail response');
  await popupRefreshAborted.page.close();

  const staleDetailA = await context.newPage();
  const staleDetailB = await context.newPage();
  await Promise.all([
    staleDetailA.goto(`http://remark.test/orders/detail?sn=${orderNumber}&mode=blank`),
    staleDetailB.goto(`http://remark.test/orders/detail?sn=${wrongOrderNumber}&mode=blank`),
  ]);
  const staleCleanup = await run('popup');
  assert.equal(staleDetailA.isClosed(), true, 'stale order-detail tabs must close before a new detail is opened');
  assert.equal(staleDetailB.isClosed(), true, 'stale detail tabs from other orders must also be cleaned');
  await staleCleanup.page.close();

  const failedPopupPage = await context.newPage();
  await failedPopupPage.goto('http://remark.test/work-order?mode=popup-blank');
  const failureBaselinePageCount = context.pages().length;
  let failurePeakPageCount = failureBaselinePageCount;
  let failedDetailOpenCalls = 0;
  let failedDetailRefreshCalls = 0;
  const trackFailurePageCount = () => {
    failurePeakPageCount = Math.max(failurePeakPageCount, context.pages().length);
  };
  context.on('page', trackFailurePageCount);
  await assert.rejects(() => addPddOrderRemark({
    targetPage: failedPopupPage,
    orderNumber,
    popupTimeoutMs: 30,
    timeoutMs: 350,
    pollMs: 20,
    settleMs: 20,
    action: async (name, callback) => {
      if (name === 'open-order-info-detail') failedDetailOpenCalls++;
      if (name === 'refresh-order-info-detail') failedDetailRefreshCalls++;
      return callback();
    },
  }), /未在限定时间内完成渲染/);
  context.off('page', trackFailurePageCount);
  assert.equal(failedDetailOpenCalls, 3, 'render failure should respect the bounded open-attempt limit');
  assert.equal(failedDetailRefreshCalls, 3, 'each bounded attempt should refresh its existing popup once');
  assert.ok(failurePeakPageCount <= failureBaselinePageCount + 1,
    'render retries must never keep more than one derived detail tab');
  assert.equal(context.pages().length, failureBaselinePageCount,
    'a final render timeout must close every popup opened by the attempt');
  await failedPopupPage.close();

  const absentPage = await context.newPage();
  await absentPage.goto('http://remark.test/work-order?mode=not-available');
  let absentDetailOpenCalls = 0;
  let absentSaveCalls = 0;
  await assert.rejects(() => addPddOrderRemark({
    targetPage: absentPage,
    orderNumber,
    popupTimeoutMs: 30,
    timeoutMs: 500,
    pollMs: 20,
    settleMs: 20,
    action: async (name, callback) => {
      if (name === 'open-order-info-detail') absentDetailOpenCalls++;
      return callback();
    },
    guardSave: async (callback) => {
      absentSaveCalls++;
      return { result: await callback(), alreadySucceeded: false };
    },
  }), /刷新并重新打开后仍未找到添加备注或修改备注入口/);
  assert.equal(absentDetailOpenCalls, 2, 'missing entry should refresh and reopen detail once');
  assert.equal(absentSaveCalls, 0, 'missing entry must never attempt save');
  assert.match(absentPage.url(), /\/work-order/);
  await absentPage.close();

  let verificationCalls = 0;
  const recoveredVerification = await run('popup-verification', {
    onVerification: async (detailPage) => {
      verificationCalls++;
      await detailPage.goto('http://remark.test/detail');
      return true;
    },
  });
  assert.equal(recoveredVerification.result.remarkStatus, 'saved');
  assert.equal(recoveredVerification.result.detailMode, 'popup');
  assert.equal(verificationCalls, 1);
  await recoveredVerification.page.close();

  let refreshedVerificationCalls = 0;
  const refreshedVerification = await run('verification-refresh', {
    onVerification: async (detailPage) => {
      refreshedVerificationCalls++;
      await detailPage.goto('http://remark.test/work-order?mode=current-page');
      return true;
    },
  });
  assert.equal(refreshedVerification.result.remarkStatus, 'saved');
  assert.equal(refreshedVerification.result.detailMode, 'current-page');
  assert.equal(refreshedVerification.detailOpenCalls, 2);
  assert.equal(refreshedVerificationCalls, 1);
  await refreshedVerification.page.close();

  const reused = await run('drawer', { alreadySucceeded: true });
  assert.equal(reused.result.remarkStatus, 'saved');
  assert.equal(reused.result.alreadySucceeded, true);
  assert.equal(await reused.page.locator('[role="dialog"] textarea:visible').count(), 0);
  await reused.page.close();

  const disabledExisting = await run('disabled-existing');
  assert.equal(disabledExisting.result.remarkStatus, 'saved');
  assert.equal(disabledExisting.result.alreadySucceeded, true);
  assert.equal(disabledExisting.saveCalls, 0, 'an existing remark must not click a disabled edit button');
  await disabledExisting.page.close();

  await assert.rejects(
    () => run('disabled-entry'),
    /PDD_ORDER_REMARK_TEMPORARILY_UNAVAILABLE/,
  );

  const loginExpiredPage = await context.newPage();
  await loginExpiredPage.goto('http://remark.test/work-order?mode=login');
  await assert.rejects(
    () => addPddOrderRemark({
      targetPage: loginExpiredPage,
      orderNumber,
      popupTimeoutMs: 30,
      timeoutMs: 500,
      pollMs: 20,
      settleMs: 20,
    }),
    (error) => {
      assert.equal(error.code, 'PDD_SESSION_EXPIRED');
      assert.equal(error.externalEffectStatus, 'failed');
      assert.equal(error.pddSessionExpiry?.source, 'pdd-order-remark-detail');
      assert.match(error.pddSessionExpiry?.url || '', /\/login$/);
      return true;
    },
  );
  await loginExpiredPage.close();

  const safeGuide = await run('safe-guide');
  assert.equal(safeGuide.result.remarkStatus, 'saved');
  assert.equal(await safeGuide.page.evaluate(() => window.safeGuideClosed), true);
  await safeGuide.page.close();

  const marketingDropdown = await run('marketing-dropdown');
  assert.equal(marketingDropdown.result.remarkStatus, 'saved');
  assert.equal(await marketingDropdown.page.evaluate(() => window.marketingMenuDismissed), true);
  await marketingDropdown.page.close();

  const stickyHeader = await run('sticky-header');
  assert.equal(stickyHeader.result.remarkStatus, 'saved');
  assert.equal(stickyHeader.detailOpenCalls, 1);
  await stickyHeader.page.close();

  const transientClickTimeout = await run('drawer', { failFirstDetailClick: true });
  assert.equal(transientClickTimeout.result.remarkStatus, 'saved');
  assert.equal(transientClickTimeout.detailOpenCalls, 2,
    'a transient unblocked detail click timeout should retry once');
  await transientClickTimeout.page.close();

  let overlayVerificationCalls = 0;
  const verificationOverlay = await run('verification-overlay', {
    onVerification: async (page) => {
      const detection = await detectHumanVerification(page);
      if (!detection) return false;
      overlayVerificationCalls++;
      await page.locator('[data-testid="beast-core-modal"]').evaluate((element) => element.remove());
      return true;
    },
  });
  assert.equal(verificationOverlay.result.remarkStatus, 'saved');
  assert.equal(overlayVerificationCalls, 1);
  assert.equal(await verificationOverlay.page.evaluate(() => window.verificationCloseClicked), false);
  await verificationOverlay.page.close();

  let lateVerificationCalls = 0;
  const lateVerification = await run('verification-on-scroll', {
    onVerification: async (page) => {
      lateVerificationCalls++;
      await page.locator('[data-testid="beast-core-modal"]').evaluate((element) => element.remove());
      return true;
    },
  });
  assert.equal(lateVerification.result.remarkStatus, 'saved');
  assert.equal(lateVerificationCalls, 1);
  assert.equal(await lateVerification.page.evaluate(() => window.verificationCloseClicked), false);
  await lateVerification.page.close();

  let entryVerificationCalls = 0;
  const entryVerification = await run('verification-during-entry', {
    onVerification: async (page) => {
      entryVerificationCalls++;
      await page.locator('[data-testid="beast-core-modal"]').evaluate((element) => element.remove());
      await page.getByRole('button', { name: '添加备注' }).evaluate((element) => {
        element.disabled = false;
      });
      return true;
    },
  });
  assert.equal(entryVerification.result.remarkStatus, 'saved');
  assert.equal(entryVerificationCalls, 1,
    'a captcha appearing while the remark button is disabled must enter verification recovery');
  assert.equal(entryVerification.saveCalls, 1);
  await entryVerification.page.close();

  const unresolvedEntryVerification = await context.newPage();
  await unresolvedEntryVerification.goto('http://remark.test/work-order?mode=verification-during-entry');
  let unresolvedSaveCalls = 0;
  await assert.rejects(() => addPddOrderRemark({
    targetPage: unresolvedEntryVerification,
    orderNumber,
    popupTimeoutMs: 300,
    timeoutMs: 1_500,
    pollMs: 20,
    settleMs: 50,
    onVerification: async () => { throw new Error('human-verification-required'); },
    action: async (_name, callback) => callback(),
    guardSave: async (callback) => {
      unresolvedSaveCalls++;
      return callback();
    },
  }), /human-verification-required/);
  assert.equal(unresolvedSaveCalls, 0,
    'an unsolved captcha must stop before any remark save');
  await unresolvedEntryVerification.close();

  const businessModal = await context.newPage();
  await businessModal.goto('http://remark.test/work-order?mode=business-modal');
  await assert.rejects(() => addPddOrderRemark({
    targetPage: businessModal,
    orderNumber,
    popupTimeoutMs: 30,
    timeoutMs: 500,
    pollMs: 20,
    settleMs: 20,
  }), /未识别的遮挡弹窗/);
  assert.equal(await businessModal.evaluate(() => window.businessModalClosed), false);
  await businessModal.close();

  const shadowVerification = await context.newPage();
  await shadowVerification.setContent('<verification-host></verification-host><script>customElements.define("verification-host",class extends HTMLElement{connectedCallback(){const root=this.attachShadow({mode:"open"});root.innerHTML=`<div class="captcha-widget"><div role="slider">向右滑动</div></div>`}})</script>');
  assert.equal((await detectHumanVerification(shadowVerification))?.confidence, 'high');
  await shadowVerification.close();

  const genericDragControl = await context.newPage();
  await genericDragControl.setContent('<div class="header-drag-handle" draggable="true" style="width:48px;height:58px">toolbar</div>');
  assert.equal(await detectHumanVerification(genericDragControl), null, 'generic draggable controls must not be treated as verification');
  await genericDragControl.close();

  const promotionalSlider = await context.newPage();
  await promotionalSlider.setContent('<div data-testid="campaign-slider-banner" style="width:1200px;height:70px">售后小助手 降低纠纷率 提升客服人力</div>');
  assert.equal(await detectHumanVerification(promotionalSlider), null,
    'a wide promotional slider must not be treated as human verification');
  await promotionalSlider.close();

  const aftersalesPhoneSetup = await context.newPage();
  await aftersalesPhoneSetup.setContent(`
    <main>
      <h1>设置售后电话</h1>
      <section>
        <h2>添加售后电话</h2>
        <p>平台将会联系店铺主要售后负责人电话，请及时联系店铺相关负责人维护售后电话。</p>
        <input placeholder="请输入手机号" />
        <input placeholder="请输入验证码" />
        <button>获取验证码</button>
        <button>确认添加</button>
      </section>
    </main>
  `);
  assert.equal(await detectHumanVerification(aftersalesPhoneSetup), null,
    'an authenticated aftersales phone SMS form must not be treated as human verification');
  await aftersalesPhoneSetup.close();

  const loginSmsVerification = await context.newPage();
  await loginSmsVerification.setContent(`
    <main>
      <h1>短信登录</h1>
      <p>请输入登录验证码</p>
      <input placeholder="请输入验证码" />
      <button>登录</button>
    </main>
  `);
  assert.equal((await detectHumanVerification(loginSmsVerification))?.reason, 'verification-text',
    'a real login SMS code prompt must remain a verification challenge');
  await loginSmsVerification.close();

  const offscreenVerification = await context.newPage();
  await offscreenVerification.setContent('<div data-testid="slider-captcha" style="position:fixed;left:-90000px;top:-1500px;width:1565px;height:70px">向右滑动</div>');
  assert.equal(await detectHumanVerification(offscreenVerification), null,
    'offscreen verification-like nodes must not pause a visible workflow');
  await offscreenVerification.close();

  const iframeVerification = await context.newPage();
  await iframeVerification.setContent('<iframe style="width:300px;height:150px" src="http://remark.test/captcha-frame"></iframe>');
  await iframeVerification.locator('iframe').waitFor({ state: 'visible' });
  assert.equal((await detectHumanVerification(iframeVerification))?.reason, 'verification-frame-url');
  await iframeVerification.close();

  const inspectionPage = await context.newPage();
  await inspectionPage.goto('http://remark.test/work-order?mode=inspect-existing');
  const inspection = await inspectPddOrderRemark({
    targetPage: inspectionPage,
    orderNumber,
    popupTimeoutMs: 300,
    timeoutMs: 1_500,
    pollMs: 20,
    settleMs: 50,
  });
  assert.equal(inspection.state, 'confirmed');
  assert.equal(inspection.readOnly, true);
  assert.match(inspection.observedText, /自动化/);
  await inspectionPage.close();

  const wrongOrderRecovery = await run('wrong-order-once');
  assert.equal(wrongOrderRecovery.result.remarkStatus, 'saved');
  assert.equal(wrongOrderRecovery.detailOpenCalls, 2,
    'a stale wrong-order detail must return to the work order and reopen once');
  await wrongOrderRecovery.page.close();

  for (const [mode, expected] of [
    ['wrong-order', /订单号与当前工单不一致/],
    ['no-red', /未找到红色标记/],
    ['blank', /未在限定时间内完成渲染/],
    ['login', /进入登录页/],
    ['verification', /进入验证页面/],
    ['popup-verification', /进入验证页面/],
    ['source-text-change', /未在限定时间内完成渲染/],
  ]) {
    const page = await context.newPage();
    await page.goto(`http://remark.test/work-order?mode=${mode}`);
    await assert.rejects(() => addPddOrderRemark({
      targetPage: page,
      orderNumber,
      popupTimeoutMs: mode === 'popup-verification' ? 300 : 30,
      timeoutMs: 350,
      pollMs: 20,
      settleMs: 20,
    }), expected, `${mode} should fail with the expected safety error`);
    await page.close();
  }

  await context.close();
  console.log('PDD order remark page-mode and safety self-test passed');
} finally {
  await browser.close();
}
