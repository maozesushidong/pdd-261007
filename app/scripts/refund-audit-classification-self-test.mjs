import assert from 'node:assert/strict';
import { activeRefundCooldowns, classifyOverdueRefunds } from './refund-audit-classification.mjs';

const rows = [
  { shopId: 'healthy', orderNumber: 'due' },
  { shopId: 'challenge', orderNumber: 'captcha' },
  { shopId: 'wrong-shop', orderNumber: 'identity' },
  { shopId: 'wrong-shop-with-challenge', orderNumber: 'identity-over-challenge' },
  { shopId: 'logged-out', orderNumber: 'login' },
  { shopId: 'logged-out-with-old-challenge', orderNumber: 'login-over-challenge' },
  { shopId: 'tms-login', orderNumber: 'tms-blocks-pdd-refunds' },
  { shopId: 'tms-and-pdd-login', orderNumber: 'pdd-login-over-tms' },
  { shopId: 'challenge', orderNumber: 'uncertain', workOrderStatus: 'paused',
    unresolvedExternalEffect: true },
  { shopId: 'healthy', orderNumber: 'paused-without-effect', workOrderStatus: 'paused',
    unresolvedExternalEffect: false },
];
const result = classifyOverdueRefunds(rows, {
  verificationShopIds: new Set(['challenge', 'logged-out-with-old-challenge',
    'wrong-shop-with-challenge']),
  identityShopIds: new Set(['wrong-shop', 'wrong-shop-with-challenge']),
  loginShopIds: new Set(['logged-out', 'logged-out-with-old-challenge', 'tms-and-pdd-login']),
  tmsLoginShopIds: new Set(['tms-login', 'tms-and-pdd-login']),
});
assert.deepEqual(result.unexplained.map(row => row.orderNumber),
  ['due', 'paused-without-effect']);
assert.deepEqual(result.unresolvedEffect.map(row => row.orderNumber), ['uncertain']);
assert.deepEqual(result.verificationBlocked.map(row => row.orderNumber), ['captcha']);
assert.deepEqual(result.identityBlocked.map(row => row.orderNumber),
  ['identity', 'identity-over-challenge']);
assert.deepEqual(result.loginBlocked.map(row => row.orderNumber),
  ['login', 'login-over-challenge', 'pdd-login-over-tms']);
assert.deepEqual(result.tmsLoginBlocked.map(row => row.orderNumber),
  ['tms-blocks-pdd-refunds']);
assert.equal(Object.values(result).reduce((count, group) => count + group.length, 0), rows.length,
  'Every overdue refund must appear in exactly one category');
const now = Date.parse('2026-09-29T14:06:00Z');
const shop = {
  shopId: 'cooling', name: 'Test shop', workerOnline: true, runtimeStatus: 'idle',
  heartbeatAt: new Date(now - 5000).toISOString(), currentOrderNumber: null,
  authHealth: Object.fromEntries(['pdd', 'oms', 'tms'].map((system) => [system, { status: 'authenticated' }])),
  workerMetadata: { state: 'pdd-verification-pressure-cooldown',
    scope: 'this-shop-only; no-active-claim', nextBusinessAt: new Date(now + 120000).toISOString(),
    currentOrderNumber: null },
};
const cooldowns = activeRefundCooldowns([shop], { now });
assert.equal(cooldowns.get('cooling').remainingSeconds, 120);
const coolingRows = [
  { shopId: 'cooling', orderNumber: 'deferred', workOrderStatus: 'retry-ready', overdueSeconds: 830 },
  { shopId: 'cooling', orderNumber: 'processing', workOrderStatus: 'processing' },
  { shopId: 'cooling', orderNumber: 'unheld-uncertain', workOrderStatus: 'retry-ready', unresolvedExternalEffect: true },
  { shopId: 'cooling', orderNumber: 'uncertain', workOrderStatus: 'paused', unresolvedExternalEffect: true },
];
const coolingResult = classifyOverdueRefunds(coolingRows, { cooldowns });
assert.deepEqual(coolingResult.cooldownBlocked, [{ ...coolingRows[0], cooldownUntil: shop.workerMetadata.nextBusinessAt }]);
assert.deepEqual(coolingResult.unexplained.map(row => row.orderNumber), ['processing', 'unheld-uncertain']);
assert.deepEqual(coolingResult.unresolvedEffect.map(row => row.orderNumber), ['uncertain']);
assert.equal(coolingRows[0].cooldownUntil, undefined, 'classification must not mutate the recorded refund');
assert.equal(Object.values(coolingResult).reduce((count, group) => count + group.length, 0), coolingRows.length);
for (const [name, change] of [
  ['offline', s => { s.workerOnline = false; }],
  ['stale heartbeat', s => { s.heartbeatAt = new Date(now - 30001).toISOString(); }],
  ['future heartbeat', s => { s.heartbeatAt = new Date(now + 1).toISOString(); }],
  ['invalid heartbeat', s => { s.heartbeatAt = 'invalid'; }],
  ['expired cooldown', s => { s.workerMetadata.nextBusinessAt = new Date(now).toISOString(); }],
  ['unbounded cooldown', s => { s.workerMetadata.nextBusinessAt = new Date(now + 300001).toISOString(); }],
  ['missing deadline', s => { delete s.workerMetadata.nextBusinessAt; }],
  ['stale metadata', s => { s.workerMetadata.state = 'queue-waiting'; }],
  ['wrong scope', s => { delete s.workerMetadata.scope; }],
  ['runtime busy', s => { s.runtimeStatus = 'processing'; }],
  ['current order', s => { s.currentOrderNumber = 'active-order'; }],
  ['heartbeat order', s => { s.workerMetadata.currentOrderNumber = 'active-order'; }],
  ...['pdd', 'oms', 'tms'].map(system => [`${system} logged out`, s => { s.authHealth[system].status = 'expired'; }]),
]) {
  const changed = structuredClone(shop); change(changed);
  const invalidCooldowns = activeRefundCooldowns([changed], { now });
  assert.equal(invalidCooldowns.size, 0, name);
  assert.equal(classifyOverdueRefunds([coolingRows[0]], { cooldowns: invalidCooldowns }).unexplained.length, 1, name);
}
for (const key of ['verificationShopIds', 'identityShopIds', 'loginShopIds', 'tmsLoginShopIds']) {
  assert.equal(classifyOverdueRefunds([coolingRows[0]], { cooldowns, [key]: new Set(['cooling']) }).cooldownBlocked.length, 0,
    `${key} must retain priority over cooldown evidence`);
}
assert.equal(activeRefundCooldowns([shop], { now: now + 120000 }).size, 0);
console.log('refund audit classification self-test passed (priority, bounded live cooldown, expiry, stale evidence, busy shop, no hidden rows)');
