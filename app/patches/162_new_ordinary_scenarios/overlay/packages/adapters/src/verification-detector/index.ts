import crypto from 'node:crypto';
import type { VerificationLocation } from '@work-order/domain';

type BrowserPage = {
  url(): string;
  evaluate<T>(pageFunction: () => T): Promise<T>;
  screenshot(options?: { type?: 'png'; fullPage?: boolean }): Promise<Buffer>;
};

export interface VerificationCapture {
  location: VerificationLocation;
  screenshot: Buffer;
}

const selectorFor = (element: Element): string => {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const classes = [...element.classList].filter(Boolean).slice(0, 2);
  return `${element.tagName.toLowerCase()}${classes.map((item) => `.${CSS.escape(item)}`).join('')}`;
};

export const detectVerificationLocation = async (input: {
  page: BrowserPage;
  shopId: string;
  system: VerificationLocation['system'];
  stage: string;
  screenshotFileId: string;
}): Promise<VerificationCapture | null> => {
  const candidate = await input.page.evaluate(() => {
    const selectors = [
      '[data-testid*="captcha" i]',
      '[data-testid*="verify" i]',
      '[class*="captcha" i]',
      '[class*="slider" i]',
      '[class*="verify" i]',
      'input[placeholder*="验证码" i]',
      'input[name*="captcha" i]',
    ];
    const trustedVerificationPageUrlPattern = /(?:login|passport|captcha|verify|verification|challenge|security|slider|puzzle|risk)/i;
    const strongVerificationContextPattern = /(?:安全验证|身份验证|人机验证|风险验证|异常登录|滑块验证|滑动验证|拖动.*滑块|向右滑|完成拼图|拼图验证)/u;
    const smsVerificationContextPattern = /(?:登录验证码|短信登录|登录验证|身份验证码|账户验证码|账号验证码|安全验证码|短信验证码已发送)/u;
    const businessSmsSetupContextPattern = /(?:设置售后电话|添加售后电话|主要售后负责人|维护售后电话|确认添加)/u;
    const visible = (element: Element) => {
      const node = element as HTMLElement;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 4 && rect.height > 4 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const elements = (root: Document | ShadowRoot) => {
      const result = [...root.querySelectorAll(selectors.join(','))];
      for (const element of [...root.querySelectorAll('*')]) {
        if (element.shadowRoot) result.push(...elements(element.shadowRoot));
      }
      return result;
    };
    for (const selector of selectors) {
      const element = elements(document).find((candidate) => candidate.matches(selector) && visible(candidate));
      if (!element) continue;
      const rect = (element as HTMLElement).getBoundingClientRect();
      const parts: string[] = [];
      let current: Element | null = element;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        const node = current as HTMLElement;
        parts.push([
          current.getAttribute('aria-label'),
          current.getAttribute('title'),
          current.getAttribute('placeholder'),
          node.innerText,
        ].filter(Boolean).join(' '));
        if (current === document.body || current === document.documentElement) break;
      }
      const contextText = parts.join(' ').replace(/\s+/g, ' ').slice(0, 4_000);
      const strongContext = strongVerificationContextPattern.test(contextText);
      const genericSmsInput = /input\[(?:placeholder|aria-label)\*="验证码"/i.test(selector);
      if (genericSmsInput
        && ((businessSmsSetupContextPattern.test(contextText) && !strongContext)
          || (!trustedVerificationPageUrlPattern.test(window.location.href)
            && !strongContext
            && !smsVerificationContextPattern.test(contextText)))) continue;
      const requiresVerificationContext = /slider|verify/i.test(selector)
        && !/captcha/i.test(selector);
      if (requiresVerificationContext) {
        const maximumControlWidth = Math.min(720, Math.max(240, window.innerWidth * 0.8));
        if (rect.width > maximumControlWidth || rect.height > 320) continue;
        if (!strongContext && !smsVerificationContextPattern.test(contextText)) continue;
      }
      return {
        selector,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        confidence: selector.includes('captcha') || selector.includes('slider') ? 'high' : 'medium',
      } as const;
    }
    return null;
  });
  if (!candidate) return null;
  const location: VerificationLocation = {
    id: crypto.randomUUID(),
    shopId: input.shopId,
    system: input.system,
    stage: input.stage,
    status: 'waiting-human',
    url: input.page.url(),
    selector: candidate.selector,
    boundingBox: { x: candidate.x, y: candidate.y, width: candidate.width, height: candidate.height },
    screenshotFileId: input.screenshotFileId,
    confidence: candidate.confidence,
    detectedAt: new Date().toISOString(),
  };
  return { location, screenshot: await input.page.screenshot({ type: 'png', fullPage: false }) };
};
