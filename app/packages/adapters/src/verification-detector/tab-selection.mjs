import crypto from 'node:crypto';
import path from 'node:path';

export const verificationTabLockPath = ({ root, shopId }) => {
  if (!root || !shopId) throw new Error('Verification tab lock requires root and shopId');
  const key = crypto.createHash('sha256').update(String(shopId)).digest('hex').slice(0, 24);
  return path.join(root, 'locks', 'verification-tabs', `${key}.lock`);
};

const browserSelections = new WeakMap();
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Select only the exact tab inside its existing window. A shop may be in the
// background or minimized; neither case requires focusing or restoring Windows.
// Serialize selection within this browser and pause around actual changes.
export const selectVerificationTab = async ({
  page,
  extensionIds = [],
  switchDelayMs = 1000,
  settleMs = 1000,
  minSwitchIntervalMs = 2500,
  extensionTimeoutMs = 5000,
  canSelect = async () => true,
} = {}) => {
  if (!page || page.isClosed()) return { selected: false, activated: false, reason: 'page-closed' };
  for (const value of [switchDelayMs, settleMs, minSwitchIntervalMs]) {
    if (!Number.isFinite(value) || value < 0) throw new Error('Tab selection delays must be nonnegative');
  }
  if (!Number.isFinite(extensionTimeoutMs) || extensionTimeoutMs <= 0) {
    throw new Error('Tab selection extension timeout must be positive');
  }
  const context = page.context();
  let state = browserSelections.get(context);
  if (!state) {
    state = { tail: Promise.resolve(), lastSwitchedAt: 0 };
    browserSelections.set(context, state);
  }
  const select = async () => {
    if (page.isClosed()) return { selected: false, activated: false, reason: 'page-closed' };
    // A timed-out activation may already have reached Chrome. Do not retry
    // another selection until its original RPC settles; only the caller's
    // observation/login recovery is allowed to continue in the meantime.
    if (state.activationPending) return {
      selected: false, activated: false, activationUnconfirmed: true,
      reason: 'tab-selection-awaiting-extension-result',
    };
    if (!await canSelect()) return { selected: false, activated: false, reason: 'tab-selection-no-longer-required' };
    const allowed = new Set(extensionIds.filter(id => /^[a-p]{32}$/u.test(id)));
    const workers = context.serviceWorkers().filter(worker => {
      const id = worker.url().match(/^chrome-extension:\/\/([a-p]{32})\//u)?.[1];
      return id && allowed.has(id);
    });
    if (!workers.length) return { selected: false, activated: false, reason: 'tab-selection-extension-unavailable' };
    let session;
    let targetId;
    try {
      session = await context.newCDPSession(page);
      targetId = (await session.send('Target.getTargetInfo')).targetInfo?.targetId;
    } catch (error) {
      return { selected: false, activated: false, reason: 'tab-target-unavailable', error: error.message };
    } finally { await session?.detach().catch(() => {}); }
    if (!targetId) return { selected: false, activated: false, reason: 'tab-target-unavailable' };

    const inspectOrSelect = async (worker, activate) => {
      const deadlineAt = Date.now() + extensionTimeoutMs;
      const operation = worker.evaluate(async ({ targetId, activate, deadlineAt }) => {
        if (!globalThis.chrome?.tabs?.update || !chrome.debugger?.getTargets) {
          return { selected: false, activated: false, reason: 'tab-selection-api-unavailable' };
        }
        const expired = () => Date.now() >= deadlineAt;
        const expiredResult = { selected: false, activated: false, reason: 'tab-selection-extension-deadline-expired' };
        if (expired()) return expiredResult;
        const target = (await chrome.debugger.getTargets()).find(item => item.id === targetId && item.type === 'page');
        if (expired()) return expiredResult;
        if (!Number.isInteger(target?.tabId) || target.tabId < 0) {
          return { selected: false, activated: false, reason: 'exact-tab-target-not-found' };
        }
        const before = await chrome.tabs.get(target.tabId);
        if (expired()) return expiredResult;
        const identity = { tabId: before.id, windowId: before.windowId, method: 'chrome-tabs-update' };
        if (before.active) return {
          ...identity, selected: true, activated: false, skipped: true,
          reason: 'verification-tab-already-selected',
        };
        if (!activate) return { ...identity, selected: false, activated: false, reason: 'tab-selection-pending' };
        // Change the tab only; never focus/restore its window or activate a CDP target.
        await chrome.tabs.update(target.tabId, { active: true });
        const after = await chrome.tabs.get(target.tabId);
        return {
          ...identity,
          selected: after.active === true && after.windowId === before.windowId,
          activated: after.active === true,
          reason: after.active ? 'verification-tab-selected' : 'verification-tab-selection-not-retained',
        };
      }, { targetId, activate, deadlineAt });
      let timer;
      try {
        return await Promise.race([
          operation,
          new Promise(resolve => {
            timer = setTimeout(() => {
              if (activate) {
                state.activationPending = operation.then(() => {}, () => {}).then(() => {
                  // Conservatively pace the next selection after the delayed
                  // result, including when Chrome never confirmed the change.
                  state.lastSwitchedAt = Date.now();
                  state.activationPending = null;
                });
              }
              resolve({ selected: false, activated: false,
                activationUnconfirmed: activate, reason: 'tab-selection-extension-timeout' });
            }, extensionTimeoutMs);
          }),
        ]);
      } finally { clearTimeout(timer); }
    };

    let lastFailure = { selected: false, activated: false, reason: 'tab-selection-api-unavailable' };
    for (const worker of workers) {
      try {
        const before = await inspectOrSelect(worker, false);
        if (before.selected) return before;
        if (before.reason !== 'tab-selection-pending') { lastFailure = before; continue; }
        const waitedBeforeMs = Math.max(switchDelayMs, state.lastSwitchedAt + minSwitchIntervalMs - Date.now());
        if (waitedBeforeMs > 0) await wait(waitedBeforeMs);
        if (page.isClosed()) return { selected: false, activated: false, reason: 'page-closed' };
        // Recheck after the pause: a person may have cleared the challenge, or
        // a new challenge may now prevent returning to a normal business tab.
        if (!await canSelect()) return { selected: false, activated: false, reason: 'tab-selection-no-longer-required' };
        const result = await inspectOrSelect(worker, true);
        if (result.activationUnconfirmed) return result;
        if (result.activated) {
          state.lastSwitchedAt = Date.now();
          result.selectedAt = new Date(state.lastSwitchedAt).toISOString();
          result.waitedBeforeMs = waitedBeforeMs;
          result.settleMs = settleMs;
          if (settleMs > 0) await wait(settleMs);
        }
        if (result.selected) return result;
        lastFailure = result;
      } catch (error) {
        lastFailure = { selected: false, activated: false, reason: 'tab-selection-failed', error: error.message };
      }
    }
    return lastFailure;
  };
  const pending = state.tail.then(select);
  state.tail = pending.catch(() => {});
  return pending;
};
