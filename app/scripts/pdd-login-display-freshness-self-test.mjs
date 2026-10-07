import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const sourceArg = process.argv.indexOf('--source');
const format = sourceArg >= 0
  ? await import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync(process.argv[sourceArg + 1], 'utf8')).toString('base64')}`)
  : await import('../apps/web/src/app/format.js');
const now = Date.parse('2026-09-30T10:20:00.000Z');
const old = '2026-09-30T07:36:43.081Z';
const fixture = {
  shopId: 'stale-observer', onboardingStatus: 'waiting-login', workerOnline: true,
  runtimeObservationStale: true, runtimeObservationAgeSeconds: 9793,
  authHealth: { pdd: { status: 'expired', checkedAt: old } },
};
const state = shop => format.pddLoginState(shop, { now });
assert.equal(state(fixture).status, 'observation-stale', 'a fresh parent heartbeat must not make old browser/login evidence current');
assert.equal(state(fixture).label, '状态待更新');
assert.equal(format.runtimeTone(state(fixture).status), 'warning');
assert.equal(state({ ...fixture, onboardingStatus: 'ready', authHealth: { pdd: { status: 'authenticated', checkedAt: old } } }).status, 'observation-stale');
assert.equal(state({ ...fixture, runtimeObservationStale: false, runtimeObservationAgeSeconds: 15 }).status, 'waiting-login');
assert.equal(state({ ...fixture, authHealth: { pdd: { status: 'expired', checkedAt: new Date(now - 10_000).toISOString() } } }).status, 'waiting-login');
assert.equal(state({ ...fixture, onboardingStatus: 'ready', authHealth: { pdd: { status: 'authenticated', checkedAt: new Date(now - 10_000).toISOString() } } }).status, 'authenticated');
assert.equal(state({ ...fixture, runtimeObservationStale: false, runtimeObservationAgeSeconds: 5, authHealth: { pdd: { status: 'verification-required', checkedAt: old } } }).status, 'verification');
assert.equal(state({ ...fixture, onboardingStatus: 'identity-mismatch' }).status, 'identity-mismatch');
assert.equal(state({ ...fixture, workerMetadata: { browserProxyHealth: { ok: false } } }).status, 'proxy-unavailable');
assert.equal(state({ onboardingStatus: 'waiting-login', runtimeObservationStale: true }).status, 'waiting-login', 'a never-observed new shop must retain its initial login instruction');
assert.equal(state({ authHealth: { pdd: { status: 'expired', checkedAt: old } } }).status, 'waiting-login', 'legacy callers without observation telemetry remain compatible');
assert.equal(state({ ...fixture, authHealth: { pdd: { status: 'expired', checkedAt: new Date(now + 1000).toISOString() } } }).status, 'observation-stale');
assert.equal(state({ ...fixture, authHealth: { pdd: { status: 'expired', checkedAt: new Date(now - 60_000).toISOString() } } }).status, 'waiting-login');
assert.equal(state({ ...fixture, runtimeObservationStale: false, runtimeObservationAgeSeconds: 60 }).status, 'waiting-login');
assert.equal(state({ ...fixture, runtimeObservationStale: false, runtimeObservationAgeSeconds: 61 }).status, 'observation-stale');
const jsx = fs.readFileSync(new URL('../apps/web/src/features/shops/ShopsView.jsx', import.meta.url), 'utf8');
assert.match(jsx, /stalePddObservation\s*=\s*pddLogin\.status\s*===\s*'observation-stale'/u);
assert.match(jsx, /等待 Worker 更新页面观察，暂不能确认自动处理状态/u);
console.log('PDD 登录显示新鲜度测试通过：14 个状态场景，错店/代理保护、新店初始登录与实际登录页提示保留');
