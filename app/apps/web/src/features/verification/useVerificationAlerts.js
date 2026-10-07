import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../services/api.js';
import { labelShop } from '../../app/format.js';

const activeStatuses = new Set(['detected', 'waiting-human', 'verification-required']);
const alertStorageKey = 'pdd-verification-desktop-alerts';

const itemKey = (item) => item.id
  || [item.shopId, item.system, item.stage, item.detectedAt, item.url].filter(Boolean).join(':');

function playAlertTone() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const context = new AudioContext();
  const start = context.currentTime;
  [0, 0.28, 0.56].forEach((offset) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.18, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.18);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.2);
  });
  window.setTimeout(() => context.close().catch(() => {}), 1200);
}

export default function useVerificationAlerts({ refreshVersion, featureEnabled, onError }) {
  const [items, setItems] = useState([]);
  const [permission, setPermission] = useState(() => (
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
  ));
  const [alertsEnabled, setAlertsEnabled] = useState(() => {
    try { return window.localStorage.getItem(alertStorageKey) === 'enabled'; } catch { return false; }
  });
  const [dismissedKeys, setDismissedKeys] = useState(() => new Set());
  const activeItems = useMemo(() => items.filter((item) => (
    activeStatuses.has(item.status) && !item.resolvedAt
  )), [items]);
  const activeKey = useMemo(() => activeItems.map(itemKey).sort().join('|'), [activeItems]);
  const visibleItems = useMemo(() => activeItems.filter((item) => !dismissedKeys.has(itemKey(item))), [activeItems, dismissedKeys]);
  const visibleKey = useMemo(() => visibleItems.map(itemKey).sort().join('|'), [visibleItems]);
  const primaryItem = useMemo(() => visibleItems[0] || null, [visibleKey]);

  useEffect(() => {
    const currentKeys = new Set(activeItems.map(itemKey));
    setDismissedKeys((current) => {
      const next = new Set([...current].filter((key) => currentKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [activeKey]);

  useEffect(() => {
    if (!featureEnabled) {
      setItems([]);
      return undefined;
    }
    let cancelled = false;
    const load = () => api('/api/v1/verifications?active=true')
      .then((result) => { if (!cancelled) setItems(result.data || []); })
      .catch((error) => { if (!cancelled) onError?.(error); });
    load();
    const timer = window.setInterval(load, 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [featureEnabled, refreshVersion, onError]);

  useEffect(() => {
    const originalTitle = document.title;
    if (!primaryItem) return undefined;
    const openNotifications = new Set();
    const activeCount = visibleKey ? visibleKey.split('|').length : 0;
    document.title = `【待验证 ${activeCount}】${originalTitle.replace(/^【待验证 \d+】/, '')}`;
    const notify = () => {
      const item = primaryItem;
      playAlertTone();
      if (!alertsEnabled || permission !== 'granted') return;
      try {
        const notification = new Notification('拼多多工单需要人工验证', {
          body: `${labelShop(item.shopId)} · ${String(item.system || 'pdd').toUpperCase()}\n请及时完成人工验证。`,
          icon: '/mascot.png',
          tag: `pdd-verification-${itemKey(item)}`,
          renotify: true,
          requireInteraction: true,
        });
        openNotifications.add(notification);
        notification.onclose = () => openNotifications.delete(notification);
        notification.onclick = () => notification.close();
      } catch { /* visual alert remains available when system notifications fail */ }
    };
    notify();
    const timer = window.setInterval(notify, 60000);
    return () => {
      window.clearInterval(timer);
      openNotifications.forEach((notification) => notification.close());
      document.title = originalTitle.replace(/^【待验证 \d+】/, '');
    };
  }, [visibleKey, primaryItem, alertsEnabled, permission]);

  const enableDesktopAlerts = useCallback(async () => {
    if (typeof Notification === 'undefined') {
      setPermission('unsupported');
      return 'unsupported';
    }
    const nextPermission = await Notification.requestPermission();
    setPermission(nextPermission);
    if (nextPermission === 'granted') {
      setAlertsEnabled(true);
      try { window.localStorage.setItem(alertStorageKey, 'enabled'); } catch { /* storage may be disabled */ }
      playAlertTone();
    }
    return nextPermission;
  }, []);

  const disableDesktopAlerts = useCallback(() => {
    setAlertsEnabled(false);
    try { window.localStorage.setItem(alertStorageKey, 'disabled'); } catch { /* storage may be disabled */ }
  }, []);

  const dismissActiveAlerts = useCallback(() => {
    setDismissedKeys((current) => {
      const next = new Set(current);
      activeItems.forEach((item) => next.add(itemKey(item)));
      return next;
    });
  }, [activeItems]);

  return {
    activeItems,
    visibleItems,
    alertsEnabled: alertsEnabled && permission === 'granted',
    permission,
    enableDesktopAlerts,
    disableDesktopAlerts,
    dismissActiveAlerts,
  };
}
