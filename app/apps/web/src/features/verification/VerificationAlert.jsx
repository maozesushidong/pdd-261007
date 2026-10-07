import React from 'react';
import { BellOff, BellRing, X } from 'lucide-react';
import { formatDateTime, labelShop } from '../../app/format.js';

export default function VerificationAlert({
  items, isOwner, desktopAlertsEnabled, onDismiss, onToggleDesktopAlerts, onDisableFrontendPush,
}) {
  if (!items.length) return null;
  const item = items[0];
  return <aside className="verification-alert" role="alert" aria-live="assertive" aria-label="需要人工验证">
    <div className="verification-alert-icon"><BellRing size={24} /></div>
    <div className="verification-alert-copy">
      <div><strong>需要人工验证</strong>{items.length > 1 && <span>{items.length} 个待处理</span>}</div>
      <p>{labelShop(item.shopId)} · {String(item.system || 'pdd').toUpperCase()} · {item.stage || '安全验证'}</p>
      <small>检测于 {formatDateTime(item.detectedAt)}。完成验证码后不要重复点击，程序会自动继续。</small>
    </div>
    <div className="verification-alert-actions">
      <button type="button" onClick={onToggleDesktopAlerts}>{desktopAlertsEnabled ? <BellOff size={14} /> : <BellRing size={14} />}{desktopAlertsEnabled ? '关闭桌面通知' : '开启桌面通知'}</button>
      {isOwner && <button type="button" onClick={onDisableFrontendPush}><BellOff size={14} />关闭前端推送</button>}
      {isOwner && <button type="button" className="verification-alert-close" aria-label="关闭当前通知" title="关闭当前通知" onClick={onDismiss}><X size={17} /></button>}
    </div>
  </aside>;
}
