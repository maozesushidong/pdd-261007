import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, BellOff, BellRing, Bot, CalendarDays, ClipboardList, Download,
  Layers3, LayoutDashboard, LogOut, RefreshCw, ScanLine, ScrollText, ShieldCheck, Store,
  UserRoundCheck, Wifi, WifiOff,
} from 'lucide-react';
import { api, ownerRequest, toQuery } from '../services/api.js';
import { ErrorBanner, IconButton, Modal } from '../components/Common.jsx';
import DashboardView from '../features/dashboard/DashboardView.jsx';
import WorkOrdersView from '../features/work-orders/WorkOrdersView.jsx';
import ChatAnalysisView from '../features/chat-analysis/ChatAnalysisView.jsx';
import LogsView from '../features/logs/LogsView.jsx';
import InterventionsView from '../features/interventions/InterventionsView.jsx';
import VerificationView from '../features/verification/VerificationView.jsx';
import ShopsView from '../features/shops/ShopsView.jsx';
import VerificationAlert from '../features/verification/VerificationAlert.jsx';
import useVerificationAlerts from '../features/verification/useVerificationAlerts.js';
import { labelScenario } from './format.js';

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const liveRefreshDebounceMs = 3000;
const ownerLoginRequested = () => new URLSearchParams(window.location.search).get('owner') === 'login';
const ownerPortalRequested = () => /^\/owner(?:\/|$)/u.test(window.location.pathname);

const navigation = [
  { id: 'dashboard', label: '运营总览', icon: LayoutDashboard },
  { id: 'work-orders', label: '工单中心', icon: ClipboardList },
  { id: 'chat-analysis', label: '聊天分析', icon: Bot },
  { id: 'logs', label: '运行日志', icon: ScrollText },
  { id: 'interventions', label: '转人工', icon: UserRoundCheck },
  { id: 'verification', label: '验证定位', icon: ScanLine },
  { id: 'shops', label: '店铺管理', icon: Store },
];

function OwnerLogin({ onClose, onLogin }) {
  const [username, setUsername] = useState('owner');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setSubmitting(true); setError(null);
    try {
      const result = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      onLogin(result.data); onClose?.();
    } catch (requestError) { setError(requestError); } finally { setSubmitting(false); }
  };
  return <Modal title="系统所有者登录" onClose={onClose} width={440}>
    <form className="form-stack" onSubmit={submit}>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <label><span>账号</span><input value={username} autoComplete="username" onChange={(event) => setUsername(event.target.value)} /></label>
      <label><span>密码</span><input value={password} type="password" autoComplete="current-password" autoFocus onChange={(event) => setPassword(event.target.value)} /></label>
      <button className="button primary wide" disabled={submitting}>{submitting ? '登录中...' : '登录'}</button>
    </form>
  </Modal>;
}

export default function App() {
  const forcedOwnerPortal = ownerPortalRequested();
  const [activeView, setActiveView] = useState('dashboard');
  const [workOrderDrilldown, setWorkOrderDrilldown] = useState(null);
  const [filters, setFilters] = useState({ from: daysAgo(6), to: today(), shopId: '', scenarioCode: '' });
  const [summary, setSummary] = useState({ total: 0, autoSuccess: 0, notSuccessful: 0, manualReview: 0, failed: 0, processing: 0, waiting: 0, verification: 0, adminOverrides: 0, byScenario: [] });
  const [shops, setShops] = useState([]);
  const [scenarios, setScenarios] = useState([]);
  const [owner, setOwner] = useState({ role: 'viewer' });
  const [connected, setConnected] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState(null);
  const [loginOpen, setLoginOpen] = useState(forcedOwnerPortal || ownerLoginRequested);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [runtime, setRuntime] = useState({ stage: 'STG', platform: 'Windows Docker', dataBackend: 'postgres', version: 'development' });
  const [runtimeCapacity, setRuntimeCapacity] = useState(null);
  const [automationControl, setAutomationControl] = useState({ state: 'unknown' });
  const [automationControlBusy, setAutomationControlBusy] = useState(false);
  const [settings, setSettings] = useState({
    verificationAlertsEnabled: true,
    dingtalkAutomaticEnabled: false,
    returnRefundScanEnabled: true,
    returnRefundAutoApproveEnabled: false,
  });

  const isOwner = owner.role === 'system-owner';
  const refresh = useCallback(() => setRefreshVersion((value) => value + 1), []);
  const openWorkOrderDetails = useCallback(({ metric = 'total', scenarioCode = '' } = {}) => {
    setWorkOrderDrilldown({ metric, scenarioCode, nonce: Date.now() });
    setActiveView('work-orders');
  }, []);
  const navigateTo = useCallback((viewId) => {
    if (viewId === 'work-orders') {
      setWorkOrderDrilldown({ metric: isOwner ? 'total' : 'autoSuccess', scenarioCode: '', nonce: Date.now() });
    }
    setActiveView(viewId);
  }, [isOwner]);
  const filterQuery = useMemo(() => toQuery(filters), [filters]);
  const {
    activeItems: activeVerifications,
    visibleItems: visibleVerifications,
    alertsEnabled,
    enableDesktopAlerts,
    disableDesktopAlerts,
    dismissActiveAlerts,
  } = useVerificationAlerts({
    refreshVersion,
    featureEnabled: settings.verificationAlertsEnabled,
    onError: setError,
  });

  const enableAlerts = useCallback(async () => {
    const permission = await enableDesktopAlerts();
    if (permission === 'denied') setError(new Error('浏览器已禁止桌面通知，请在地址栏的网站设置中允许“通知”后刷新页面。'));
    if (permission === 'unsupported') setError(new Error('当前浏览器不支持桌面通知，请保持管理台页面打开以接收红色提醒。'));
  }, [enableDesktopAlerts]);

  const toggleDesktopAlerts = useCallback(async () => {
    if (alertsEnabled) {
      disableDesktopAlerts();
      return;
    }
    await enableAlerts();
  }, [alertsEnabled, disableDesktopAlerts, enableAlerts]);

  const updateVerificationAlerts = useCallback(async (enabled) => {
    try {
      const result = await ownerRequest('/api/v1/settings/verification-alerts', owner.csrfToken, {
        method: 'PATCH', body: JSON.stringify({ enabled }),
      });
      setSettings(result.data);
    } catch (requestError) { setError(requestError); }
  }, [owner.csrfToken]);

  const controlAlerts = useCallback(() => {
    if (isOwner) {
      updateVerificationAlerts(!settings.verificationAlertsEnabled);
      return;
    }
    if (settings.verificationAlertsEnabled) enableAlerts();
  }, [isOwner, settings.verificationAlertsEnabled, updateVerificationAlerts, enableAlerts]);

  const updateDingTalkAutomatic = useCallback(async (automaticEnabled) => {
    try {
      const result = await ownerRequest('/api/v1/settings/dingtalk', owner.csrfToken, {
        method: 'PATCH', body: JSON.stringify({ automaticEnabled }),
      });
      setSettings(result.data);
    } catch (requestError) { setError(requestError); }
  }, [owner.csrfToken]);

  const updateReturnRefundSettings = useCallback(async (updates) => {
    try {
      const result = await ownerRequest('/api/v1/settings/return-refund', owner.csrfToken, {
        method: 'PATCH', body: JSON.stringify(updates),
      });
      setSettings(result.data);
    } catch (requestError) { setError(requestError); }
  }, [owner.csrfToken]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const authResult = await api('/api/v1/auth/me');
      const nextOwner = authResult.data || { role: 'viewer' };
      if (cancelled) return;
      setOwner(nextOwner);
      if (forcedOwnerPortal && nextOwner.role !== 'system-owner') {
        setLoginOpen(true);
        setInitialLoading(false);
        return;
      }
      const [summaryResult, shopsResult, scenariosResult, runtimeResult, settingsResult, capacityResult] = await Promise.all([
        api(`/api/v1/metrics/summary?${filterQuery}`), api('/api/v1/shops'), api('/api/v1/scenarios'),
        api('/api/v1/runtime'), api('/api/v1/settings'), api('/api/v1/runtime/capacity'),
      ]);
      if (cancelled) return;
      setSummary(summaryResult.data || {});
      setShops(shopsResult.data || []);
      setScenarios(scenariosResult.data || []);
      setRuntime(runtimeResult.data || runtime);
      setRuntimeCapacity(capacityResult.data || null);
      setSettings({
        verificationAlertsEnabled: true,
        dingtalkAutomaticEnabled: false,
        returnRefundScanEnabled: true,
        returnRefundAutoApproveEnabled: false,
        ...(settingsResult.data || {}),
      });
      if (nextOwner.role === 'system-owner') {
        try { setAutomationControl((await ownerRequest('/api/v1/runtime/control', nextOwner.csrfToken)).data || { state: 'unknown' }); } catch { /* owner control is optional during upgrade */ }
      }
      setLastUpdatedAt(new Date());
      setError(null);
    };
    load().catch((requestError) => {
      if (!cancelled) setError(requestError);
    }).finally(() => !cancelled && setInitialLoading(false));
    return () => { cancelled = true; };
  }, [filterQuery, refreshVersion, owner.role, forcedOwnerPortal]);

  const controlAutomation = useCallback(async (action) => {
    setAutomationControlBusy(true);
    try {
      const result = await ownerRequest('/api/v1/runtime/control', owner.csrfToken, {
        method: 'POST', body: JSON.stringify({ action }),
      });
      setAutomationControl(result.data || { state: action === 'start' ? 'starting' : 'stopping' });
    } catch (requestError) { setError(requestError); } finally { setAutomationControlBusy(false); }
  }, [owner.csrfToken]);

  useEffect(() => {
    const openHiddenLogin = (event) => {
      if (!isOwner && event.ctrlKey && event.altKey && event.shiftKey && event.code === 'KeyO') {
        event.preventDefault();
        setLoginOpen(true);
      }
    };
    window.addEventListener('keydown', openHiddenLogin);
    return () => window.removeEventListener('keydown', openHiddenLogin);
  }, [isOwner]);

  useEffect(() => {
    if (initialLoading) return undefined;
    const stream = new EventSource('/api/v1/events', { withCredentials: true });
    let refreshTimer = null;
    const onEvent = () => {
      setConnected(true);
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, liveRefreshDebounceMs);
    };
    const eventTypes = [
      'connected', 'worker-events.ingested', 'worker-asset.ingested', 'work-order.classification-updated',
      'work-order.bulk-classification-updated', 'work-order.classification-rolled-back',
      'work-order.data-corrected', 'work-order.deleted', 'manual-intervention.updated', 'verification.recheck-requested',
      'verification.force-clear-requested', 'verification.refresh-next-requested',
      'verification.screenshot-deleted', 'verification.screenshots-deleted', 'evidence.screenshot-deleted',
      'shop.created', 'shop.updated', 'shop.deleted', 'shop.login-requested',
      'shop.system-login-requested', 'shop.local-browser-requested',
      'settings.verification-alerts-updated', 'settings.dingtalk-updated',
      'settings.return-refund-updated', 'work-order.dingtalk-queued',
      'dingtalk.daily-summary-updated', 'dingtalk.daily-summary-sent',
      'dingtalk.daily-summary-failed',
      'audit-event.created',
    ];
    eventTypes.forEach((type) => stream.addEventListener(type, onEvent));
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    return () => { clearTimeout(refreshTimer); stream.close(); };
  }, [refresh, isOwner, initialLoading]);

  useEffect(() => {
    if (!isOwner || initialLoading) return undefined;
    let cancelled = false;
    let polling = false;
    const pollShopStatus = async () => {
      if (polling) return;
      polling = true;
      try {
        const result = await api('/api/v1/shops');
        if (!cancelled) {
          setShops(result.data || []);
          setLastUpdatedAt(new Date());
        }
      } catch { /* the main request cycle reports connectivity errors */ }
      finally { polling = false; }
    };
    const timer = window.setInterval(pollShopStatus, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [isOwner, initialLoading]);

  const logout = async () => {
    await api('/api/v1/auth/logout', { method: 'POST' }).catch(() => {});
    setOwner({ role: 'viewer' });
    setSummary({ total: 0, autoSuccess: 0, notSuccessful: 0 });
    setShops([]);
    setScenarios([]);
    setConnected(false);
    setError(null);
    if (forcedOwnerPortal) setLoginOpen(true);
    refresh();
  };
  const handleOwnerLogin = (nextOwner) => {
    setOwner(nextOwner);
    setLoginOpen(false);
    refresh();
  };

  const commonProps = {
    filters, shops, scenarios, owner, isOwner, refreshVersion, refresh, setError,
    runtime, runtimeCapacity, settings, updateDingTalkAutomatic, updateReturnRefundSettings,
  };
  const currentView = {
    dashboard: <DashboardView {...commonProps} summary={summary} loading={initialLoading} onOpenWorkOrders={openWorkOrderDetails} />,
    'work-orders': <WorkOrdersView {...commonProps} drilldown={workOrderDrilldown} />,
    'chat-analysis': <ChatAnalysisView {...commonProps} />,
    logs: <LogsView {...commonProps} />,
    interventions: <InterventionsView {...commonProps} />,
    verification: <VerificationView {...commonProps} />,
    shops: <ShopsView {...commonProps} />,
  }[activeView];

  if (forcedOwnerPortal && !isOwner) {
    return <div className="owner-login-gate">
      <OwnerLogin onLogin={handleOwnerLogin} />
    </div>;
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><img src="/mascot.png" alt="拼多多" /><div><strong>拼多多</strong><span>工单自动化运营台</span></div></div>
      <nav>{navigation.map((item) => <button key={item.id} className={activeView === item.id ? 'active' : ''} onClick={() => navigateTo(item.id)}><item.icon size={18} /><span>{item.label}</span></button>)}</nav>
      <div className="sidebar-foot"><div className="environment"><span className="environment-mark">{runtime.stage}</span><div><strong>{runtime.platform}</strong><small>{runtime.dataBackend === 'postgres' ? 'PostgreSQL 数据源' : `${runtime.dataBackend} 数据源`}</small></div></div></div>
    </aside>

    <div className="workspace">
      <header className="topbar">
        <div className="topbar-context"><Store size={18} /><select aria-label="店铺范围" value={filters.shopId} onChange={(event) => setFilters((current) => ({ ...current, shopId: event.target.value }))}><option value="">全部店铺</option>{shops.map((shop) => <option value={shop.shopId} key={shop.shopId}>{shop.name || shop.shopId}</option>)}</select></div>
        <div className="topbar-context"><Layers3 size={18} /><select aria-label="业务场景" value={filters.scenarioCode} onChange={(event) => setFilters((current) => ({ ...current, scenarioCode: event.target.value }))}><option value="">全部业务场景</option>{scenarios.map((scenario) => <option value={scenario.code} key={scenario.code}>{scenario.displayName || labelScenario(scenario.code)}</option>)}</select></div>
        <div className="date-range"><CalendarDays size={17} /><input aria-label="开始日期" type="date" value={filters.from} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} /><span>至</span><input aria-label="结束日期" type="date" value={filters.to} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} /></div>
        <div className="topbar-actions">
          <span className={`connection ${connected ? 'online' : 'offline'}`}>{connected ? <Wifi size={16} /> : <WifiOff size={16} />}{connected ? '实时连接' : '连接中断'}</span>
          <IconButton
            label={isOwner
              ? (settings.verificationAlertsEnabled ? '关闭全局验证码提醒' : '开启全局验证码提醒')
              : (!settings.verificationAlertsEnabled ? '验证码提醒已由所有者关闭' : (alertsEnabled ? '桌面验证码提醒已开启' : '开启桌面验证码提醒'))}
            className={`${settings.verificationAlertsEnabled && alertsEnabled ? 'notification-enabled' : ''} ${visibleVerifications.length ? 'alerting' : ''}`}
            onClick={controlAlerts}
            disabled={!isOwner && !settings.verificationAlertsEnabled}
          >
            {settings.verificationAlertsEnabled ? <BellRing size={17} /> : <BellOff size={17} />}
            {activeVerifications.length > 0 && <span className="notification-count">{activeVerifications.length}</span>}
          </IconButton>
          <IconButton label="刷新数据" onClick={refresh}><RefreshCw size={17} /></IconButton>
          {isOwner && <a className="icon-button" title="导出当前工单" aria-label="导出当前工单" href={`/api/v1/exports/work-orders.csv?${filterQuery}`}><Download size={17} /></a>}
          {isOwner && <><div className="automation-control"><span className={`control-state ${automationControl.state}`}>{automationControl.state === 'starting' ? '启动中' : automationControl.state === 'stopping' ? '停止中' : automationControl.state === 'running' ? '运行中' : automationControl.state === 'stopped' ? '已停止' : '状态未知'}</span><button className="button" disabled={automationControlBusy || ['starting', 'running'].includes(automationControl.state)} onClick={() => controlAutomation('start')}>启动项目</button><button className="button" disabled={automationControlBusy || ['stopping', 'stopped'].includes(automationControl.state)} onClick={() => controlAutomation('stop')}>停止项目</button></div><button className="owner-chip" onClick={logout}><ShieldCheck size={16} /><span>系统所有者</span><LogOut size={15} /></button></>}
        </div>
      </header>

      <div className="mobile-nav">{navigation.map((item) => <button key={item.id} className={activeView === item.id ? 'active' : ''} onClick={() => navigateTo(item.id)} title={item.label}><item.icon size={18} /><span>{item.label}</span></button>)}</div>
      <main className="content">
        <ErrorBanner error={error} onClose={() => setError(null)} />
        {currentView}
      </main>
      <footer className="statusbar"><span><Activity size={14} />数据源 {runtime.dataBackend === 'postgres' ? 'PostgreSQL' : runtime.dataBackend}</span><span><Bot size={14} />{shops.length} 店铺动态 Worker</span><span>版本 {runtime.version}</span><span>最近刷新 {lastUpdatedAt ? lastUpdatedAt.toLocaleTimeString('zh-CN', { hour12: false }) : '-'}</span></footer>
    </div>
    <VerificationAlert
      items={visibleVerifications}
      isOwner={isOwner}
      desktopAlertsEnabled={alertsEnabled}
      onDismiss={dismissActiveAlerts}
      onToggleDesktopAlerts={toggleDesktopAlerts}
      onDisableFrontendPush={() => updateVerificationAlerts(false)}
    />
    {loginOpen && <OwnerLogin
      onClose={forcedOwnerPortal ? undefined : () => setLoginOpen(false)}
      onLogin={handleOwnerLogin}
    />}
  </div>;
}
