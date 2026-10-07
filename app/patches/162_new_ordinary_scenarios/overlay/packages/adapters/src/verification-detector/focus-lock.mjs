import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

const processIsAlive = (pid) => {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const normalizePriority = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 10;
};

const isWindowsLockContention = (error) => ['EBUSY', 'EPERM'].includes(error?.code);

export const releaseVerificationFocusLock = ({
  lockPath,
  pid,
  token,
  readOwner,
  unlinkSync = fs.unlinkSync,
  renameSync = fs.renameSync,
  randomToken = () => crypto.randomUUID(),
} = {}) => {
  const owner = readOwner?.();
  if (owner?.token !== token || Number(owner?.pid) !== Number(pid)) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    if (!isWindowsLockContention(error)) throw error;
  }

  // Antivirus and file-indexing processes can temporarily hold a Windows file
  // handle. Renaming removes the active lock name atomically; cleanup of the
  // isolated file is best effort because it no longer blocks another shop.
  const suffix = String(randomToken()).replace(/[^a-z0-9-]/gi, '') || 'isolated';
  const quarantinePath = `${lockPath}.released-${pid}-${suffix}`;
  try {
    renameSync(lockPath, quarantinePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    if (isWindowsLockContention(error)) return false;
    throw error;
  }
  try {
    unlinkSync(quarantinePath);
  } catch {
    // A quarantined file is not an active lock and can be cleaned later.
  }
  return true;
};

export const createVerificationFocusCoordinator = ({
  lockPath,
  shopId,
  pid = process.pid,
  hostname = os.hostname(),
  pollMs = 1000,
  heartbeatMs = 2000,
  ownerStaleMs = 60_000,
  malformedLockStaleMs = 30_000,
  queueStaleMs = Math.max(ownerStaleMs * 2, 120_000),
  priorityAgingMs = 30_000,
  isOwnerAlive = processIsAlive,
  delay = wait,
  now = () => Date.now(),
  randomToken = () => crypto.randomUUID(),
} = {}) => {
  if (!lockPath) throw new Error('verification focus lockPath is required');
  if (!shopId) throw new Error('verification focus shopId is required');

  const resolvedLockPath = path.resolve(lockPath);
  const queuePath = `${resolvedLockPath}.queue`;
  let ownedToken = null;
  let heartbeatTimer = null;
  let localTurnTail = Promise.resolve();
  let releaseOwnedLocalTurn = null;

  const acquireLocalTurn = async () => {
    const previousTurn = localTurnTail;
    let releaseTurn;
    localTurnTail = new Promise((resolve) => {
      releaseTurn = resolve;
    });
    await previousTurn;
    return releaseTurn;
  };

  const readOwner = () => {
    try {
      return JSON.parse(fs.readFileSync(resolvedLockPath, 'utf8'));
    } catch {
      return null;
    }
  };

  const removeStaleLock = (owner) => {
    let stale = false;
    if (owner?.lockVersion === 1 && owner.token && owner.pid) {
      const heartbeatAt = Date.parse(owner.heartbeatAt || owner.acquiredAt || '');
      stale = (Number.isFinite(heartbeatAt) && now() - heartbeatAt >= ownerStaleMs)
        || (owner.hostname === hostname && !isOwnerAlive(owner.pid));
    } else {
      try {
        stale = now() - fs.statSync(resolvedLockPath).mtimeMs >= malformedLockStaleMs;
      } catch (error) {
        if (error.code === 'ENOENT') return true;
        throw error;
      }
    }
    if (!stale) return false;
    try {
      fs.unlinkSync(resolvedLockPath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
  };

  const startHeartbeat = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (!ownedToken) return;
      const owner = readOwner();
      if (owner?.token !== ownedToken || Number(owner.pid) !== Number(pid)) {
        ownedToken = null;
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        return;
      }
      try {
        fs.writeFileSync(resolvedLockPath, JSON.stringify({
          ...owner,
          heartbeatAt: new Date(now()).toISOString(),
        }), { mode: 0o600 });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  };

  const readQueueRequest = (requestPath) => {
    try {
      return JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    } catch {
      return null;
    }
  };

  const removeQueueRequest = (requestPath) => {
    if (!requestPath) return false;
    try {
      fs.unlinkSync(requestPath);
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }
  };

  const queueRequests = () => {
    let entries;
    try {
      entries = fs.readdirSync(queuePath, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const requests = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const requestPath = path.join(queuePath, entry.name);
      const request = readQueueRequest(requestPath);
      let modifiedAtMs = 0;
      try {
        modifiedAtMs = fs.statSync(requestPath).mtimeMs;
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const parsedHeartbeatAt = Date.parse(request?.heartbeatAt || request?.enqueuedAt || '');
      const heartbeatAtMs = Math.max(
        Number.isFinite(parsedHeartbeatAt) ? parsedHeartbeatAt : 0,
        modifiedAtMs,
      );
      const malformedAndStale = (!request?.token || !request?.pid)
        && now() - modifiedAtMs >= malformedLockStaleMs;
      const stale = malformedAndStale
        || (request?.hostname === hostname && request?.pid && !isOwnerAlive(request.pid))
        || (request?.token && request?.pid && now() - heartbeatAtMs >= queueStaleMs);
      if (stale) {
        removeQueueRequest(requestPath);
        continue;
      }
      if (!request?.token || !request?.pid) continue;
      requests.push({ ...request, requestPath });
    }
    const effectivePriority = (request) => {
      const basePriority = normalizePriority(request.priority);
      if (!Number.isFinite(priorityAgingMs) || priorityAgingMs <= 0) return basePriority;
      const waitedMs = Math.max(0, now() - Number(request.enqueuedAtMs || 0));
      return Math.max(0, basePriority - Math.floor(waitedMs / priorityAgingMs));
    };
    return requests.sort((left, right) => (
      effectivePriority(left) - effectivePriority(right)
      || Number(left.enqueuedAtMs) - Number(right.enqueuedAtMs)
      || String(left.token).localeCompare(String(right.token))
    ));
  };

  const acquire = async ({ stage, priority = 10, isStillRequired, onWaiting } = {}) => {
    // A shop can detect the same challenge from overlapping browser work. If
    // those calls all enter the filesystem queue before one acquires the
    // lock, their abandoned request files can block every shop until stale
    // cleanup. Serialize requests inside this process so each shop exposes
    // exactly one verification page at a time.
    const releaseLocalTurn = await acquireLocalTurn();
    let keepLocalTurn = false;

    try {
      fs.mkdirSync(path.dirname(resolvedLockPath), { recursive: true, mode: 0o700 });
      fs.mkdirSync(queuePath, { recursive: true, mode: 0o700 });
      const token = randomToken();
      const enqueuedAtMs = now();
      const queuePriority = normalizePriority(priority);
      const queueRequestPath = path.join(
        queuePath,
        `${String(enqueuedAtMs).padStart(16, '0')}-${pid}-${token}.json`,
      );
      const queueRequest = {
        queueVersion: 1,
        token,
        pid,
        hostname,
        shopId,
        stage: stage || null,
        priority: queuePriority,
        enqueuedAtMs,
        enqueuedAt: new Date(enqueuedAtMs).toISOString(),
        heartbeatAt: new Date(enqueuedAtMs).toISOString(),
      };
      fs.writeFileSync(queueRequestPath, JSON.stringify(queueRequest), { flag: 'wx', mode: 0o600 });
      let waitingSince = null;
      let lastNotifiedOwnerToken = null;
      let lastQueueHeartbeatAt = enqueuedAtMs;
      try {
        while (!ownedToken) {
          if (isStillRequired && !await isStillRequired()) {
            return { acquired: false, status: 'cleared-while-queued' };
          }
          const checkedAt = now();
          if (checkedAt - lastQueueHeartbeatAt >= heartbeatMs) {
            const heartbeatDate = new Date(checkedAt);
            try {
              fs.utimesSync(queueRequestPath, heartbeatDate, heartbeatDate);
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
              fs.writeFileSync(queueRequestPath, JSON.stringify(queueRequest), { flag: 'wx', mode: 0o600 });
            }
            lastQueueHeartbeatAt = checkedAt;
          }
          const queue = queueRequests();
          const queueHead = queue[0] || null;
          const isQueueHead = queueHead?.token === token;
          if (isQueueHead) {
            const owner = {
              lockVersion: 1,
              token,
              pid,
              hostname,
              shopId,
              stage: stage || null,
              priority: queuePriority,
              acquiredAt: new Date(checkedAt).toISOString(),
              heartbeatAt: new Date(checkedAt).toISOString(),
            };
            try {
              fs.writeFileSync(resolvedLockPath, JSON.stringify(owner), {
                flag: 'wx',
                mode: 0o600,
              });
              ownedToken = token;
              keepLocalTurn = true;
              releaseOwnedLocalTurn = releaseLocalTurn;
              removeQueueRequest(queueRequestPath);
              startHeartbeat();
              return { acquired: true, owner, reused: false };
            } catch (error) {
              if (error.code !== 'EEXIST') throw error;
            }
          }

          const currentOwner = readOwner();
          const staleLockRemoved = removeStaleLock(currentOwner);
          if (staleLockRemoved && isQueueHead) continue;
          waitingSince ||= new Date(checkedAt).toISOString();
          const waitingBehind = currentOwner || queueHead;
          const currentOwnerToken = waitingBehind?.token || '(unknown-owner)';
          if (currentOwnerToken !== lastNotifiedOwnerToken) {
            lastNotifiedOwnerToken = currentOwnerToken;
            await onWaiting?.({ owner: waitingBehind, waitingSince });
          }
          await delay(pollMs);
        }
      } finally {
        if (!ownedToken) removeQueueRequest(queueRequestPath);
      }
    } finally {
      if (!keepLocalTurn) releaseLocalTurn();
    }
    return { acquired: true, owner: readOwner(), reused: false };
  };

  const release = () => {
    const releaseLocalTurn = releaseOwnedLocalTurn;
    releaseOwnedLocalTurn = null;
    if (!ownedToken) {
      releaseLocalTurn?.();
      return false;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    try {
      return releaseVerificationFocusLock({
        lockPath: resolvedLockPath,
        pid,
        token: ownedToken,
        readOwner,
        randomToken,
      });
    } finally {
      ownedToken = null;
      releaseLocalTurn?.();
    }
  };

  return {
    acquire,
    release,
    readOwner,
    hasWaiters: () => queueRequests().length > 0,
    ownsLock: () => Boolean(ownedToken),
    lockPath: resolvedLockPath,
  };
};
