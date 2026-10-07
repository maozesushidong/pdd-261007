import assert from 'node:assert/strict';
import {
  createBrowserHealthMonitor,
  normalizeBrowserProcessExitCode,
} from '../apps/worker/src/browser-health-monitor.mjs';
import { decideBrowserProbeFailure } from '../packages/adapters/src/browser-runtime-state.mjs';

assert.equal(normalizeBrowserProcessExitCode({
  code: 0xFFFFFFFF,
  platform: 'win32',
}), 90);
assert.deepEqual(decideBrowserProbeFailure({
  connected: true,
  pageCount: 3,
  failureCount: 1,
  failureLimit: 4,
  error: new Error('Chromium CDP probe timed out'),
}), {
  definitivelyUnavailable: false,
  restart: false,
  failureCount: 1,
  failureLimit: 4,
});
assert.equal(decideBrowserProbeFailure({
  connected: true,
  pageCount: 3,
  failureCount: 4,
  failureLimit: 4,
  error: new Error('Chromium CDP probe timed out'),
}).restart, true);
assert.equal(decideBrowserProbeFailure({
  connected: false,
  pageCount: 3,
  failureCount: 1,
  failureLimit: 4,
  error: new Error('Chromium connection is closed'),
}).restart, true);
assert.equal(decideBrowserProbeFailure({
  connected: true,
  pageCount: 0,
  failureCount: 1,
  failureLimit: 4,
  error: new Error('Chromium has no usable pages'),
}).restart, true);
assert.equal(normalizeBrowserProcessExitCode({
  code: -1,
  platform: 'win32',
}), 90);
assert.equal(normalizeBrowserProcessExitCode({
  code: 0,
  platform: 'win32',
}), 0);
assert.equal(normalizeBrowserProcessExitCode({
  code: 0xFFFFFFFF,
  platform: 'linux',
}), 0xFFFFFFFF);
assert.equal(normalizeBrowserProcessExitCode({
  code: 1,
  browserHealthFailure: { reason: 'browser-heartbeat-timeout' },
  platform: 'win32',
}), 90);

let currentTime = 0;
let intervalCallback = null;
let intervalCleared = false;
const failures = [];
const child = {};
const monitor = createBrowserHealthMonitor({
  heartbeatTimeoutMs: 20_000,
  startupGraceMs: 90_000,
  checkIntervalMs: 5_000,
  onFailure: (failure) => failures.push(failure),
  now: () => currentTime,
  setIntervalFn: (callback) => {
    intervalCallback = callback;
    return { unref() {} };
  },
  clearIntervalFn: () => { intervalCleared = true; },
});

monitor.attach(child);
currentTime = 89_000;
assert.equal(monitor.check(), false);
assert.equal(failures.length, 0);

assert.equal(monitor.record(child, {
  type: 'browser-health',
  healthy: true,
  connected: true,
  pageCount: 3,
}), true);
currentTime = 109_000;
assert.equal(intervalCallback(), true);
await Promise.resolve();
assert.equal(failures.length, 1);
assert.equal(failures[0].reason, 'browser-heartbeat-timeout');
assert.equal(monitor.check(), false);

const replacement = {};
monitor.attach(replacement);
currentTime = 111_000;
monitor.record(replacement, {
  type: 'browser-health',
  healthy: false,
  connected: false,
  pageCount: 0,
  reason: 'browser-health-probe-failed',
});
await Promise.resolve();
assert.equal(failures.length, 2);
assert.equal(failures[1].reason, 'browser-health-probe-failed');

monitor.detach(replacement);
currentTime = 300_000;
assert.equal(monitor.check(), false);
monitor.close();
assert.equal(intervalCleared, true);

let startupFailure = null;
const startupMonitor = createBrowserHealthMonitor({
  heartbeatTimeoutMs: 15_000,
  startupGraceMs: 90_000,
  checkIntervalMs: 2_500,
  onFailure: (failure) => { startupFailure = failure; },
  now: () => currentTime,
  setIntervalFn: () => ({ unref() {} }),
  clearIntervalFn: () => {},
});
startupMonitor.attach({});
currentTime += 90_000;
assert.equal(startupMonitor.check(), true);
await Promise.resolve();
assert.equal(startupFailure.reason, 'browser-heartbeat-startup-timeout');
startupMonitor.close();

console.log('browser health timeout and recovery self-test passed');
