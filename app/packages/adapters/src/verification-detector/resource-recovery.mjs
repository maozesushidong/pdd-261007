const resourceFailurePattern = /验证资源获取失败\s*[,，]\s*请重试/u;

const resourceFailureFingerprint = (detection, frameUrl = '') => [
  frameUrl,
  detection?.boundingBox?.x,
  detection?.boundingBox?.y,
  detection?.boundingBox?.width,
  detection?.boundingBox?.height,
].join('|');

const attemptedResourceRefreshes = new WeakMap();

export const isVerificationResourceFailureDetection = (detection) => (
  detection?.reason === 'verification-resource-failed'
);

export const findVerificationResourceFailureCandidate = async (frame) => frame.evaluate(() => {
  const visible = (element) => {
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 4
      && rect.height > 4
      && rect.right > 0
      && rect.bottom > 0
      && rect.left < (document.documentElement.clientWidth || window.innerWidth)
      && rect.top < (document.documentElement.clientHeight || window.innerHeight)
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity || 1) > 0;
  };
  const all = [...document.querySelectorAll('*')];
  const messagePattern = /验证资源获取失败\s*[,，]\s*请重试/u;
  const messageText = (element) => String(element.innerText || element.textContent || '').replace(/\s+/gu, ' ');
  const messages = all
    .filter((element) => visible(element)
      && messagePattern.test(messageText(element))
      // An opaque ancestor's innerText also contains text from transparent
      // children. Inspect the innermost message instead of promoting it.
      && ![...element.children].some((child) => messagePattern.test(messageText(child))))
    .sort((left, right) => String(left.innerText || left.textContent || '').length
      - String(right.innerText || right.textContent || '').length);
  const message = messages[0];
  if (!message) return null;
  let surface = message;
  for (let depth = 0; surface && depth < 10; depth += 1, surface = surface.parentElement) {
    if (surface === document.body || surface === document.documentElement) break;
    const rect = surface.getBoundingClientRect();
    const metadata = `${surface.id || ''} ${surface.className || ''} ${surface.getAttribute?.('role') || ''}`;
    if (visible(surface)
      && rect.width >= 160
      && rect.height >= 70
      && rect.width <= 1_400
      && rect.height <= 900
      && (/(?:captcha|verify|verification|challenge|slider|puzzle|modal)/iu.test(metadata)
        || surface.getAttribute?.('role') === 'dialog')) break;
  }
  const rect = (surface || message).getBoundingClientRect();
  return {
    selector: 'text:验证资源获取失败',
    boundingBox: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    confidence: 'high',
    reason: 'verification-resource-failed',
  };
}).catch(() => null);

export const refreshVerificationResourceFailure = async (
  page,
  detection,
  { maxAttempts = 1 } = {},
) => {
  if (!page || page.isClosed?.()) return { clicked: false, reason: 'page-closed' };
  if (!isVerificationResourceFailureDetection(detection)) {
    return { clicked: false, reason: 'not-resource-failure' };
  }
  const frame = page.frames().find((candidate) => candidate.url() === detection.frameUrl)
    || page.mainFrame();
  if (!frame) return { clicked: false, reason: 'frame-not-found' };
  const fingerprint = resourceFailureFingerprint(detection, frame.url());
  const previous = attemptedResourceRefreshes.get(page);
  if (previous?.fingerprint === fingerprint && previous.attempts >= maxAttempts) {
    return { clicked: false, reason: 'resource-refresh-attempt-limit', attempts: previous.attempts };
  }
  const result = await frame.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width >= 8
        && rect.height >= 8
        && rect.right > 0
        && rect.bottom > 0
        && rect.left < (document.documentElement.clientWidth || window.innerWidth)
        && rect.top < (document.documentElement.clientHeight || window.innerHeight)
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) > 0;
    };
    const message = [...document.querySelectorAll('*')]
      .filter((element) => visible(element)
        && /验证资源获取失败\s*[,，]\s*请重试/u.test(
          String(element.innerText || element.textContent || '').replace(/\s+/gu, ' '),
        ))
      .sort((left, right) => String(left.innerText || left.textContent || '').length
        - String(right.innerText || right.textContent || '').length)[0];
    if (!message) return { clicked: false, reason: 'resource-failure-gone' };
    let surface = message;
    for (let depth = 0; surface && depth < 10; depth += 1, surface = surface.parentElement) {
      if (surface === document.body || surface === document.documentElement) break;
      const rect = surface.getBoundingClientRect();
      const metadata = `${surface.id || ''} ${surface.className || ''} ${surface.getAttribute?.('role') || ''}`;
      if (visible(surface)
        && rect.width >= 160
        && rect.height >= 70
        && rect.width <= 1_400
        && rect.height <= 900
        && (/(?:captcha|verify|verification|challenge|slider|puzzle|modal)/iu.test(metadata)
          || surface.getAttribute?.('role') === 'dialog')) break;
    }
    const scope = surface || message.parentElement || message;
    const refreshHint = /(?:刷新|重试|重新获取|refresh|retry)/iu;
    const controls = [...scope.querySelectorAll(
      'button,[role="button"],[aria-label],[title],[data-testid],[class*="refresh" i],[class*="retry" i]',
    )]
      .filter((element) => visible(element))
      .map((element) => {
        const metadata = [
          element.innerText,
          element.getAttribute('aria-label'),
          element.getAttribute('title'),
          element.getAttribute('data-testid'),
          element.id,
          element.className,
        ].filter(Boolean).join(' ');
        const rect = element.getBoundingClientRect();
        const explicit = refreshHint.test(metadata);
        const semanticControl = ['button', 'a'].includes(String(element.tagName || '').toLowerCase())
          || String(element.getAttribute('role') || '').toLowerCase() === 'button';
        return { element, metadata, rect, score: (explicit ? 0 : 100) + (semanticControl ? 0 : 20) };
      })
      .filter(({ metadata, element }) => refreshHint.test(metadata)
        && element.getAttribute('aria-disabled') !== 'true'
        && element.disabled !== true)
      .sort((left, right) => left.score - right.score
        || (left.rect.width * left.rect.height) - (right.rect.width * right.rect.height));
    const target = controls[0];
    if (!target) return { clicked: false, reason: 'refresh-control-not-found' };
    target.element.click();
    return {
      clicked: true,
      method: 'captcha-local-refresh-control',
      control: target.metadata.slice(0, 240),
    };
  }).catch((error) => ({ clicked: false, reason: `refresh-click-failed:${error.message}` }));
  const attempts = (previous?.fingerprint === fingerprint ? previous.attempts : 0)
    + (result.clicked ? 1 : 0);
  attemptedResourceRefreshes.set(page, { fingerprint, attempts, attemptedAt: Date.now() });
  return { ...result, attempts, fingerprint };
};
