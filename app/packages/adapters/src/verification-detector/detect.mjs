import { findExpiredVerificationModalCandidate } from './expired-modal.mjs';
import { findVerificationResourceFailureCandidate } from './resource-recovery.mjs';

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
// PDD varies the instruction text for image-selection challenges (objects,
// shapes, colors, letters, numbers, and case matching). The modal still must
// contain a challenge image/canvas and a visible close control, so matching
// the instruction prefix is sufficient without treating normal text as a
// verification surface.
const imageClickInstructionPattern = /请点击[^。！？\n]{1,160}/u;
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
  // Playwright's isVisible includes fully transparent elements. PDD can keep
  // an old challenge mounted after hiding it, so also check ancestor opacity.
  if (!await locator.evaluate((element) => element.checkVisibility({
    opacityProperty: true,
    visibilityProperty: true,
  })).catch(() => false)) return false;
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
      const box = await candidate.boundingBox().catch(() => null);
      // PDD briefly renders a tiny text-only shell while a challenge iframe or
      // slider is being mounted. Treating that shell as a live CAPTCHA makes
      // the worker select the tab too early and can invalidate the operator's
      // first drag. Require a readable text box, or a real challenge control
      // in the same rendered subtree before accepting the text signal.
      const hasVisibleChallengeCompanion = await candidate.evaluate((element) => {
        const challengeSelector = [
          'iframe',
          'canvas',
          'img',
          '[data-testid*="captcha" i]',
          '[data-testid*="slider" i]',
          '[data-testid*="puzzle" i]',
          '[class*="captcha" i]',
          '[class*="slider" i]',
          '[class*="puzzle" i]',
          '[role="slider"]',
          '[draggable="true"]',
        ].join(',');
        const isVisibleChallenge = (candidateNode) => {
          const rect = candidateNode.getBoundingClientRect();
          const style = window.getComputedStyle(candidateNode);
          const tagName = String(candidateNode.tagName || '').toLowerCase();
          const visualNode = /^(?:iframe|canvas|img)$/u.test(tagName);
          const minimumWidth = visualNode ? 80 : 40;
          const minimumHeight = visualNode ? 30 : 8;
          return rect.width >= minimumWidth
            && rect.height >= minimumHeight
            && rect.right > 0
            && rect.bottom > 0
            && rect.left < (document.documentElement.clientWidth || window.innerWidth)
            && rect.top < (document.documentElement.clientHeight || window.innerHeight)
            && style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity || 1) > 0;
        };
        let current = element;
        for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
          const rect = current.getBoundingClientRect();
          const style = window.getComputedStyle(current);
          if (rect.width >= 80 && rect.height >= 30
            && style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity || 1) > 0) {
            if (current.matches?.(challengeSelector) && isVisibleChallenge(current)) return true;
            if ([...current.querySelectorAll(challengeSelector)].some(isVisibleChallenge)) return true;
          }
        }
        return false;
      }).catch(() => false);
      if ((!box || box.width < 40 || box.height < 8) && !hasVisibleChallengeCompanion) continue;
      if (genericSmsTextPatterns.has(pattern)
        && !await hasTrustedVerificationContext(frame, candidate)) continue;
      return {
        selector: `text:${pattern.source}`,
        boundingBox: roundedBox(box),
        confidence: hasVisibleChallengeCompanion ? 'high' : 'medium',
        reason: 'verification-text',
      };
    }
  }
  return null;
};

// Detect only an image-selection challenge with its instruction, challenge
// image/canvas, and an actionable close control. PDD renders several versions
// of this surface: sometimes the X is inside a modal, sometimes it is an
// absolutely-positioned sibling of the captcha container. Resolve the visual
// surface first, then accept a close control in its small top-right perimeter.
const findImageClickModalCandidate = async (frame) => frame.evaluate((instructionSource) => {
  const instruction = new RegExp(instructionSource, 'u');
  const visible = (element) => {
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 4 && rect.height > 4
      && rect.right > 0
      && rect.bottom > 0
      && rect.left < (document.documentElement.clientWidth || window.innerWidth)
      && rect.top < (document.documentElement.clientHeight || window.innerHeight)
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity || 1) > 0;
  };
  const roots = [document];
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    for (const element of roots[rootIndex].querySelectorAll('*')) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  const queryAll = (selector) => roots.flatMap((root) => [...root.querySelectorAll(selector)]);
  const closeSelector = [
    '[data-testid="beast-core-modal-close-button"]',
    '[data-testid*="close" i]',
    '[aria-label="关闭"]',
    '[title="关闭"]',
    '[aria-label="Close"]',
    '[title="Close"]',
    '[id*="close" i]',
    '[class*="close" i]',
  ].join(',');
  const closeHint = /(?:关闭|close|×)/iu;
  const challengeVisual = (element) => {
    if (!visible(element)) return false;
    const rect = element.getBoundingClientRect();
    const tag = String(element.tagName || '').toLowerCase();
    if (!/^(?:img|canvas|svg|picture)$/u.test(tag)
      && (rect.width < 120 || rect.height < 60)) return false;
    if (/^(?:img|canvas|svg|picture)$/u.test(tag)) {
      return rect.width >= 120 && rect.height >= 60;
    }
    const style = window.getComputedStyle(element);
    const renderedImage = [
      style.backgroundImage,
      style.maskImage,
      style.webkitMaskImage,
    ].some((value) => value && value !== 'none');
    return renderedImage
      || /captcha|verify|puzzle|challenge/iu.test(
        `${element.id || ''} ${element.className || ''} ${element.getAttribute?.('data-testid') || ''}`,
      );
  };
  const hasChallengeVisual = (element) => {
    const explicit = [...element.querySelectorAll([
      'img',
      'canvas',
      'svg',
      'picture',
      '[class*="captcha" i]',
      '[class*="verify" i]',
      '[class*="puzzle" i]',
      '[class*="challenge" i]',
      '[data-testid*="captcha" i]',
      '[data-testid*="verify" i]',
      '[data-testid*="challenge" i]',
    ].join(','))];
    if (explicit.some(challengeVisual)) return true;
    // Current PDD image-selection dialogs commonly paint the challenge as a
    // CSS background on an otherwise anonymous div. Inspect only reasonably
    // sized visible descendants so that the strict instruction + rendered
    // image pair is still required and ordinary page text cannot match.
    const descendants = [...element.querySelectorAll('*')];
    for (let index = 0; index < Math.min(descendants.length, 1_200); index += 1) {
      if (challengeVisual(descendants[index])) return true;
    }
    return false;
  };
  const instructionNodes = queryAll('*')
    .filter((element) => visible(element) && instruction.test(String(element.innerText || element.textContent || '')))
    .sort((left, right) => (
      String(left.innerText || left.textContent || '').length
      - String(right.innerText || right.textContent || '').length
      || (left.getBoundingClientRect().width * left.getBoundingClientRect().height)
        - (right.getBoundingClientRect().width * right.getBoundingClientRect().height)
    ));
  const surfaceFor = (node) => {
    let current = node;
    for (let depth = 0; current && depth < 12; depth += 1, current = current.parentElement) {
      // Never promote a challenge into the page-wide body/document surface.
      // A temporary image redraw can leave only a challenge-like class on a
      // child; accepting body here would calculate the X at the page corner.
      if (current === document.body || current === document.documentElement) break;
      const rect = current.getBoundingClientRect();
      if (visible(current) && rect.width >= 200 && rect.height >= 120
        && rect.width <= 1_200 && rect.height <= 900 && hasChallengeVisual(current)) return current;
    }
    return null;
  };
  const closeFor = (surface) => {
    const surfaceRect = surface.getBoundingClientRect();
    const candidates = queryAll(`${closeSelector},button,[role="button"]`)
      .filter((element) => visible(element));
    const near = candidates
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => (
        rect.right >= surfaceRect.left - 24
        && rect.left <= surfaceRect.right + 80
        && rect.bottom >= surfaceRect.top - 80
        && rect.top <= surfaceRect.top + 100
      ))
      .filter(({ element }) => (
        closeHint.test(String(element.innerText || ''))
        || closeHint.test(`${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`)
        || closeHint.test(`${element.id || ''} ${element.className || ''}`)
        || /^(?:button)$/iu.test(String(element.tagName || ''))
        || String(element.getAttribute('role') || '').toLowerCase() === 'button'
      ));
    near.sort((left, right) => {
      const leftCenter = left.rect.x + left.rect.width / 2;
      const rightCenter = right.rect.x + right.rect.width / 2;
      const leftScore = Math.abs(leftCenter - surfaceRect.right) + Math.abs(left.rect.y - surfaceRect.top);
      const rightScore = Math.abs(rightCenter - surfaceRect.right) + Math.abs(right.rect.y - surfaceRect.top);
      return leftScore - rightScore;
    });
    return near[0]?.element || null;
  };
  for (const instructionNode of instructionNodes) {
    const surface = surfaceFor(instructionNode);
    if (!surface) continue;
    const closeButton = closeFor(surface);
    const surfaceRect = surface.getBoundingClientRect();
    const closeRect = closeButton?.getBoundingClientRect() || {
      x: surfaceRect.right - 18,
      y: surfaceRect.top - 18,
      width: 36,
      height: 36,
    };
    return {
      selector: surface.getAttribute('data-testid')
        ? `[data-testid="${surface.getAttribute('data-testid')}"]`
        : surface.getAttribute('role') === 'dialog'
          ? '[role="dialog"]'
          : surface.classList?.contains('ant-modal')
            ? '.ant-modal'
            : surface.classList?.contains('beast-core-modal')
              ? '.beast-core-modal'
              : '[class*="captcha" i]',
      closeSelector,
      boundingBox: {
        x: Math.round(surfaceRect.x),
        y: Math.round(surfaceRect.y),
        width: Math.round(surfaceRect.width),
        height: Math.round(surfaceRect.height),
      },
      closeBoundingBox: {
        x: Math.round(closeRect.x),
        y: Math.round(closeRect.y),
        width: Math.round(closeRect.width),
        height: Math.round(closeRect.height),
      },
      closeMethod: closeButton ? 'element' : 'surface-corner',
      confidence: 'high',
      reason: 'image-click-modal',
    };
  }

  // During a short PDD redraw the challenge image can be mounted in a
  // sibling iframe or remain temporarily invisible while the instruction and
  // close control are already rendered. Keep the strict "请点击" signal,
  // but use the nearby close control/panel geometry as a bounded fallback so
  // the workflow still dismisses this image-selection modal. Slider prompts
  // use "请向右滑" and never enter this branch.
  for (const instructionNode of instructionNodes) {
    const instructionRect = instructionNode.getBoundingClientRect();
    const candidateSurface = (() => {
      let current = instructionNode;
      for (let depth = 0; current && depth < 10; depth += 1, current = current.parentElement) {
        if (current === document.body || current === document.documentElement) break;
        const rect = current.getBoundingClientRect();
        const style = window.getComputedStyle(current);
        const classText = `${current.id || ''} ${current.className || ''}`;
        if (visible(current)
          && rect.width >= 200 && rect.height >= 120
          && rect.width <= 1_400 && rect.height <= 900
          && (/(?:fixed|absolute)/u.test(style.position)
            || /(?:captcha|verify|puzzle|challenge|modal)/iu.test(classText))) {
          return current;
        }
      }
      return null;
    })();
    const surfaceRect = candidateSurface?.getBoundingClientRect() || {
      x: Math.max(0, instructionRect.x - 24),
      y: Math.max(0, instructionRect.y - 48),
      width: Math.max(240, instructionRect.width + 96),
      height: 180,
    };
    const candidates = queryAll(`${closeSelector},button,[role="button"]`)
      .filter((element) => visible(element))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => (
        rect.right >= surfaceRect.left - 24
        && rect.left <= surfaceRect.right + 80
        && rect.bottom >= surfaceRect.top - 80
        && rect.top <= surfaceRect.top + 100
      ))
      .filter(({ element, rect }) => {
        const metadata = [
          element.innerText,
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
          element.id,
          element.className,
        ].filter(Boolean).join(' ');
        const compactButton = rect.width >= 12 && rect.width <= 72
          && rect.height >= 12 && rect.height <= 72
          && (String(element.tagName || '').toLowerCase() === 'button'
            || String(element.getAttribute('role') || '').toLowerCase() === 'button');
        return closeHint.test(metadata) || compactButton;
      })
      .sort((left, right) => {
        const leftCenter = left.rect.x + left.rect.width / 2;
        const rightCenter = right.rect.x + right.rect.width / 2;
        const leftScore = Math.abs(leftCenter - surfaceRect.right)
          + Math.abs(left.rect.y - surfaceRect.top);
        const rightScore = Math.abs(rightCenter - surfaceRect.right)
          + Math.abs(right.rect.y - surfaceRect.top);
        return leftScore - rightScore;
      });
    const closeButton = candidates[0]?.element || null;
    const closeRect = candidates[0]?.rect || {
      x: surfaceRect.right - 18,
      y: surfaceRect.top - 18,
      width: 36,
      height: 36,
    };
    // A fallback without a visible close affordance would risk classifying a
    // normal instruction as a dismissible challenge. Require either a close
    // control or an explicitly challenge-like positioned panel.
    if (!closeButton && !candidateSurface) continue;
    return {
      selector: candidateSurface?.getAttribute('data-testid')
        ? `[data-testid="${candidateSurface.getAttribute('data-testid')}"]`
        : '[class*="captcha" i]',
      closeSelector,
      boundingBox: {
        x: Math.round(surfaceRect.x),
        y: Math.round(surfaceRect.y),
        width: Math.round(surfaceRect.width),
        height: Math.round(surfaceRect.height),
      },
      closeBoundingBox: {
        x: Math.round(closeRect.x),
        y: Math.round(closeRect.y),
        width: Math.round(closeRect.width),
        height: Math.round(closeRect.height),
      },
      closeMethod: closeButton ? 'element' : 'surface-corner',
      confidence: 'high',
      reason: 'image-click-modal',
    };
  }
  return null;
}, imageClickInstructionPattern.source).catch(() => null);

const findSelectorCandidate = async (frame) => {
  for (const selector of verificationSelectors) {
    const matches = frame.locator(selector);
    const count = await matches.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const candidate = matches.nth(index);
      if (!await isVisible(candidate, frame.page())) continue;
      const box = await candidate.boundingBox().catch(() => null);
      if (!box || box.width < 12 || box.height < 8) continue;
      if (/captcha|puzzle/i.test(selector) && (box.width < 40 || box.height < 20)) continue;
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
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
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
    if (frame !== mainFrame) {
      const frameElement = await frame.frameElement().catch(() => null);
      if (!frameElement || !await isVisible(frameElement, targetPage)) continue;
      if (verificationFrameUrlPattern.test(frameUrl)) {
        return {
          selector: 'iframe[src*="verification"]',
          boundingBox: roundedBox(await frameElement.boundingBox().catch(() => null)),
          confidence: 'high',
          reason: 'verification-frame-url',
          frameUrl,
        };
      }
    }
    const resourceFailureCandidate = await findVerificationResourceFailureCandidate(frame);
    if (resourceFailureCandidate) return { ...resourceFailureCandidate, frameUrl };
    // Preserve an explicit terminal message as a verification surface even
    // when its slider/control has already disappeared. The workflow may only
    // auto-close the narrower "验证时间过长，请重试" variant; other expired
    // messages remain visible for normal manual handling.
    const expiredModalCandidate = await findExpiredVerificationModalCandidate(frame);
    if (expiredModalCandidate) return { ...expiredModalCandidate, frameUrl };
    const imageClickModalCandidate = await findImageClickModalCandidate(frame);
    if (imageClickModalCandidate) return { ...imageClickModalCandidate, frameUrl };
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

export const isImageClickVerificationDetection = (detection) => (
  detection?.reason === 'image-click-modal'
);
