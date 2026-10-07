// Slow only the first business interactions after a PDD login or a cleared
// business CAPTCHA. Read-only DOM checks and manual login stay responsive.
const BUSINESS_URL = 'https://mms.pinduoduo.com/';
const LOGIN_URL = /^https:\/\/mms\.pinduoduo\.com\/login(?:[/?#]|$)/u;
const INTERACTION = /^(?:(?:page|frame|locator|handle)\.(?:click|dblclick|tap|hover|fill|clear|press|type|pressSequentially|check|uncheck|setChecked|selectOption|setInputFiles|focus|blur|dispatchEvent|dragTo|dragAndDrop|scrollIntoViewIfNeeded|goto|reload|goBack|goForward|bringToFront|move|down|up|wheel|insertText))$/u;

export const createPddPostLoginRecoveryPacing = ({
  intervalMs = 3500,
  durationMs = 180_000,
  now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) => {
  let activeUntil = 0;
  let nextAt = 0;
  let armed = false;
  let queue = Promise.resolve();

  const start = () => {
    // The browser may remain paused for a long time after login or CAPTCHA
    // clearance. Start the slow window with its first automated business
    // interaction so the protection does not expire while the shop is idle.
    armed = true;
    activeUntil = 0;
    nextAt = 0;
    return { armedAt: now(), intervalMs, durationMs };
  };

  const beforeOperation = (page, operation) => {
    if (!INTERACTION.test(operation)
      || !page || page.isClosed?.()
      || !String(page.url?.() || '').startsWith(BUSINESS_URL)
      || LOGIN_URL.test(String(page.url?.() || ''))
      || (!armed && now() >= activeUntil)
      || intervalMs <= 0 || durationMs <= 0) return Promise.resolve(false);
    const turn = queue.then(async () => {
      if (armed) {
        const startedAt = now();
        activeUntil = startedAt + durationMs;
        nextAt = startedAt + intervalMs;
        armed = false;
      }
      if (now() >= activeUntil) return false;
      const delay = Math.max(0, nextAt - now());
      if (delay) await sleep(delay);
      // A second login resets the window while a queued operation is waiting.
      if (now() >= activeUntil || page.isClosed?.()) return false;
      nextAt = now() + intervalMs;
      return true;
    });
    queue = turn.catch(() => {});
    return turn;
  };

  return { start, beforeOperation };
};
