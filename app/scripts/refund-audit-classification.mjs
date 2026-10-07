// A live, bounded cooldown explains a queue delay, not a completed refund.
// Expired/stale waits and busy shops must remain eligible for fault reporting.
export const activeRefundCooldowns = (shops, { now = Date.now() } = {}) => {
  const cooldowns = new Map();
  for (const shop of shops) {
    const metadata = shop.workerMetadata || {};
    const heartbeatAt = Date.parse(shop.heartbeatAt || '');
    const nextBusinessAt = Date.parse(metadata.nextBusinessAt || '');
    if (shop.workerOnline !== true || shop.runtimeStatus !== 'idle'
      || shop.currentOrderNumber || metadata.currentOrderNumber
      || metadata.state !== 'pdd-verification-pressure-cooldown'
      || metadata.scope !== 'this-shop-only; no-active-claim'
      || !['pdd', 'oms', 'tms'].every((system) => shop.authHealth?.[system]?.status === 'authenticated')
      || !Number.isFinite(heartbeatAt) || now < heartbeatAt || now - heartbeatAt > 30_000
      || !Number.isFinite(nextBusinessAt) || nextBusinessAt <= now
      || nextBusinessAt - now > 5 * 60_000) continue;
    cooldowns.set(shop.shopId, {
      shopId: shop.shopId,
      shopName: shop.name,
      heartbeatAt: shop.heartbeatAt,
      nextBusinessAt: metadata.nextBusinessAt,
      remainingSeconds: Math.ceil((nextBusinessAt - now) / 1000),
    });
  }
  return cooldowns;
};

export const classifyOverdueRefunds = (refunds, {
  verificationShopIds = new Set(),
  identityShopIds = new Set(),
  loginShopIds = new Set(),
  tmsLoginShopIds = new Set(),
  cooldowns = new Map(),
} = {}) => {
  const categories = {
    unexplained: [],
    unresolvedEffect: [],
    verificationBlocked: [],
    identityBlocked: [],
    loginBlocked: [],
    tmsLoginBlocked: [],
    cooldownBlocked: [],
  };
  for (const refund of refunds) {
    if (refund.workOrderStatus === 'paused' && refund.unresolvedExternalEffect === true) {
      categories.unresolvedEffect.push(refund);
    } else if (loginShopIds.has(refund.shopId)) {
      categories.loginBlocked.push(refund);
    } else if (identityShopIds.has(refund.shopId)) {
      categories.identityBlocked.push(refund);
    } else if (verificationShopIds.has(refund.shopId)) {
      categories.verificationBlocked.push(refund);
    } else if (tmsLoginShopIds.has(refund.shopId)) {
      categories.tmsLoginBlocked.push(refund);
    } else if (refund.workOrderStatus === 'retry-ready'
      && refund.unresolvedExternalEffect !== true && cooldowns.has(refund.shopId)) {
      categories.cooldownBlocked.push({ ...refund,
        cooldownUntil: cooldowns.get(refund.shopId).nextBusinessAt });
    } else {
      categories.unexplained.push(refund);
    }
  }
  return categories;
};
