const smsCodePromptPattern = /请输入.*验证码/;
const smsCodeSentPattern = /短信验证码已发送/;

const verificationTextPatterns = [
  /正在进行安全验证/,
  /请完成安全验证/,
  /安全验证.*(?:验证码|滑块|拼图)/,
  /请完成.*验证/,
  smsCodePromptPattern,
  smsCodeSentPattern,
  /拖动.*滑块/,
  /滑块验证/,
  /请向右滑(?:动|块).*完成拼图/,
  /完成拼图/,
  /滑动验证/,
];

const verificationSelectors = [
  '[data-testid*="captcha" i]',
  '[data-testid*="verify" i]',
  '[data-testid*="slider" i]',
  '[data-testid*="puzzle" i]',
  '[class*="captcha" i]',
  '[class*="slider" i]',
  '[class*="verify" i]',
  '[class*="puzzle" i]',
  '[id*="captcha" i]',
  '[id*="slider" i]',
  '[id*="verify" i]',
  '[id*="puzzle" i]',
  '[role="slider"]',
  'input[placeholder*="验证码" i]',
  'input[aria-label*="验证码" i]',
  'input[name*="captcha" i]',
  'input[id*="captcha" i]',
];

const verificationFrameUrlPattern = /(?:captcha|verify|verification|challenge|slider|puzzle)/i;
const trustedVerificationPageUrlPattern = /(?:login|passport|captcha|verify|verification|challenge|security|slider|puzzle|risk)/i;
const strongVerificationContextPattern = /(?:安全验证|身份验证|人机验证|风险验证|异常登录|滑块验证|滑动验证|拖动.*滑块|向右滑|完成拼图|拼图验证)/u;
const smsVerificationContextPattern = /(?:登录验证码|短信登录|登录验证|身份验证码|账户验证码|账号验证码|安全验证码|短信验证码已发送)/u;
const businessSmsSetupContextPattern = /(?:设置售后电话|添加售后电话|主要售后负责人|维护售后电话|确认添加)/u;
const genericSmsTextPatterns = new Set([smsCodePromptPattern, smsCodeSentPattern]);
const genericSmsInputSelectorPattern = /input\[(?:placeholder|aria-label)\*="验证码"/i;

const roundedBox = (box) => box ? {
  x: Math.round(box.x),
  y: Math.round(box.y),
  width: Math.round(box.width),
  height: Math.round(box.height),
} : null;

export const boxIntersectsViewport = (box, viewport) => Boolean(
  box
  && viewport
  && box.width > 4
  && box.height > 4
  && box.x + box.width > 0
  && box.y + box.height > 0
  && box.x < viewport.width
  && box.y < viewport.height
);

const isVisible = async (locator, page) => {
  if (!await locator.isVisible().catch(() => false)) return false;
  const box = await locator.boundingBox().catch(() => null);
  const viewport = page.viewportSize() || await page.evaluate(() => ({
    width: document.documentElement.clientWidth || window.innerWidth,
    height: document.documentElement.clientHeight || window.innerHeight,
  })).catch(() => null);
  return boxIntersectsViewport(box, viewport);
};

const candidateVerificationContext = async (candidate) => candidate.evaluate((element) => {
  const parts = [];
  let current = element;
  for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
    parts.push([
      current.getAttribute?.('aria-label'),
      current.getAttribute?.('title'),
      current.getAttribute?.('placeholder'),
      current.innerText,
    ].filter(Boolean).join(' '));
    if (current === document.body || current === document.documentElement) break;
  }
  return parts.join(' ').replace(/\s+/g, ' ').slice(0, 4_000);
}).catch(() => '');

const hasTrustedVerificationContext = async (frame, candidate) => {
  const contextText = await candidateVerificationContext(candidate);
  const strongContext = strongVerificationContextPattern.test(contextText);
  if (businessSmsSetupContextPattern.test(contextText) && !strongContext) return false;
  return trustedVerificationPageUrlPattern.test(frame.url())
    || strongContext
    || smsVerificationContextPattern.test(contextText);
};

const findTextCandidate = async (frame) => {
  for (const pattern of verificationTextPatterns) {
    const matches = frame.getByText(pattern);
    const count = await matches.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const candidate = matches.nth(index);
      if (!await isVisible(candidate, frame.page())) continue;
      if (genericSmsTextPatterns.has(pattern)
        && !await hasTrustedVerificationContext(frame, candidate)) continue;
      return {
        selector: `text:${pattern.source}`,
        boundingBox: roundedBox(await candidate.boundingBox().catch(() => null)),
        confidence: 'high',
        reason: 'verification-text',
      };
    }
  }
  return null;
};

const findSelectorCandidate = async (frame) => {
  for (const selector of verificationSelectors) {
    const matches = frame.locator(selector);
    const count = await matches.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const candidate = matches.nth(index);
      if (!await isVisible(candidate, frame.page())) continue;
      const box = await candidate.boundingBox().catch(() => null);
      if (!box || box.width < 12 || box.height < 8) continue;
      if (genericSmsInputSelectorPattern.test(selector)
        && !await hasTrustedVerificationContext(frame, candidate)) continue;
      const requiresVerificationContext = /slider|role="slider"|verify/i.test(selector)
        && !/captcha|puzzle|验证码/i.test(selector);
      if (requiresVerificationContext) {
        const viewport = frame.page().viewportSize();
        const maximumControlWidth = Math.min(720, Math.max(240, Number(viewport?.width || 0) * 0.8));
        if (box.width > maximumControlWidth || box.height > 320) continue;
        const contextText = await candidate.evaluate((element) => {
          const parts = [];
          let current = element;
          for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
            if (current === document.body || current === document.documentElement) break;
            parts.push([
              current.getAttribute?.('aria-label'),
              current.getAttribute?.('title'),
              current.getAttribute?.('placeholder'),
              current.innerText,
            ].filter(Boolean).join(' '));
          }
          return parts.join(' ').replace(/\s+/g, ' ').slice(0, 2_000);
        }).catch(() => '');
        if (!strongVerificationContextPattern.test(contextText)
          && !smsVerificationContextPattern.test(contextText)) continue;
      }
      return {
        selector,
        boundingBox: roundedBox(box),
        confidence: /captcha|slider|puzzle|role="slider"/i.test(selector) ? 'high' : 'medium',
        reason: 'verification-control',
      };
    }
  }
  return null;
};

const findStructuredModalCandidate = async (frame) => frame.evaluate(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 40 && rect.height > 30
      && rect.right > 0
      && rect.bottom > 0
      && rect.left < (document.documentElement.clientWidth || window.innerWidth)
      && rect.top < (document.documentElement.clientHeight || window.innerHeight)
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity || 1) > 0;
  };
  const roots = [document];
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
    for (const element of roots[rootIndex].querySelectorAll('*')) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  const queryAll = (selector) => roots.flatMap((root) => [...root.querySelectorAll(selector)]);
  const modals = queryAll([
    '[data-testid="beast-core-modal-container"]',
    '[data-testid="beast-core-modal"]',
    '.beast-core-modal',
    '[role="dialog"]',
  ].join(','));
  const sliderSelector = [
    '[data-testid*="captcha" i]',
    '[data-testid*="slider" i]',
    '[data-testid*="puzzle" i]',
    '[class*="captcha" i]',
    '[class*="slider" i]',
    '[class*="puzzle" i]',
    '[class*="drag" i]',
    '[id*="captcha" i]',
    '[id*="slider" i]',
    '[id*="puzzle" i]',
    '[role="slider"]',
    '[draggable="true"]',
    'input[type="range"]',
  ].join(',');
  for (const modal of modals) {
    if (!visible(modal)) continue;
    const hasVisualChallenge = [...modal.querySelectorAll('img, canvas')]
      .some((element) => visible(element));
    const hasSliderControl = [...modal.querySelectorAll(sliderSelector)]
      .some((element) => visible(element));
    if (!hasVisualChallenge || !hasSliderControl) continue;
    const rect = modal.getBoundingClientRect();
    return {
      selector: modal.getAttribute('data-testid')
        ? `[data-testid="${modal.getAttribute('data-testid')}"]`
        : modal.getAttribute('role') === 'dialog'
          ? '[role="dialog"]'
          : '.beast-core-modal',
      boundingBox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      confidence: 'high',
      reason: 'image-slider-modal',
    };
  }
  return null;
}).catch(() => null);

export const detectHumanVerification = async (targetPage) => {
  if (!targetPage || targetPage.isClosed()) return null;
  const mainFrame = targetPage.mainFrame();
  for (const frame of targetPage.frames()) {
    const frameUrl = frame.url();
    if (frame !== mainFrame && verificationFrameUrlPattern.test(frameUrl)) {
      const frameElement = await frame.frameElement().catch(() => null);
      if (frameElement && await isVisible(frameElement, targetPage)) {
        return {
          selector: 'iframe[src*="verification"]',
          boundingBox: roundedBox(await frameElement.boundingBox().catch(() => null)),
          confidence: 'high',
          reason: 'verification-frame-url',
          frameUrl,
        };
      }
    }
    const textCandidate = await findTextCandidate(frame);
    if (textCandidate) return { ...textCandidate, frameUrl };
    const selectorCandidate = await findSelectorCandidate(frame);
    if (selectorCandidate) return { ...selectorCandidate, frameUrl };
    const modalCandidate = await findStructuredModalCandidate(frame);
    if (modalCandidate) return { ...modalCandidate, frameUrl };
  }
  return null;
};

export const hasHumanVerification = async (targetPage) => Boolean(
  await detectHumanVerification(targetPage),
);
