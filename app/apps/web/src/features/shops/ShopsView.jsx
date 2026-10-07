import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Clock3, ExternalLink, Filter, LogIn,
  MonitorUp, Pencil, Plus, Power, PowerOff, LockOpen, Search, ServerCog, Store, Trash2, WifiOff,
  Workflow, X,
} from 'lucide-react';
import { ErrorBanner, Modal, StatusBadge } from '../../components/Common.jsx';
import { api, ownerRequest } from '../../services/api.js';
import {
  formatDateTime, labelScenario, pddLoginState, remoteDesktopUrl, runtimeTone,
} from '../../app/format.js';

const localBrowserError = (error) => {
  const message = ({
    'windows-local-browser-launcher-unavailable': 'Windows 本地浏览器控制任务尚未启动，请重新连接服务器远程桌面后重试。',
    'windows-local-browser-launch-failed': 'Windows 本地浏览器启动失败，请检查服务器上的 Chrome。',
    'chrome-not-installed': '服务器未安装 Google Chrome。',
    'shop-profile-path-invalid': '店铺浏览器 Profile 路径无效。',
    'oms-credentials-incomplete': 'OMS 账号和密码需要同时填写，或同时留空。',
    'oms-credentials-storage-unavailable': '服务器未配置 secrets 目录，暂不能保存 OMS 自动登录凭证。',
  })[error?.message];
  return message ? new Error(message) : error;
};

const systemLoginState = (shop, system) => {
  const status = String(shop.authHealth?.[system]?.status || 'unknown');
  if (status === 'authenticated') return { status, label: '已登录', needsLogin: false };
  if (status === 'verification-required') return { status, label: '待验证', needsLogin: true };
  if (status === 'expired') return { status, label: '需要登录', needsLogin: true };
  if (status === 'unreachable') return { status, label: '连接异常', needsLogin: false };
  return { status, label: '待初次登录', needsLogin: true };
};

function ShopInitializationModal({
  shop, onClose, onOpenPdd, onOpenOms, onOpenTms, refresh,
}) {
  const [busySystem, setBusySystem] = useState(null);
  const [error, setError] = useState(null);
  const pddLogin = pddLoginState(shop);
  const omsLogin = systemLoginState(shop, 'oms');
  const tmsLogin = systemLoginState(shop, 'tms');
  const pddReady = pddLogin.status === 'authenticated';
  const omsReady = omsLogin.status === 'authenticated';
  const tmsReady = tmsLogin.status === 'authenticated';
  const initializationComplete = pddReady && omsReady && tmsReady;

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [refresh, shop.shopId]);

  const run = async (system, action) => {
    setBusySystem(system);
    setError(null);
    try {
      await action(shop);
      refresh();
    } catch (requestError) {
      setError(requestError);
    } finally {
      setBusySystem(null);
    }
  };

  return <Modal title={`初始化店铺：${shop.name || shop.shopId}`} onClose={onClose} width={600}>
    <div className="shop-initialization-summary">
      <Store size={21} />
      <div><strong>{shop.name || shop.shopId}</strong><small>{shop.shopId} · 拼多多、OMS、TMS 均使用本店 Worker 的独立持久会话</small></div>
      <StatusBadge status={initializationComplete ? 'authenticated' : 'waiting-login'} label={initializationComplete ? '初始化完成' : '等待登录'} />
    </div>
    <ErrorBanner error={error} onClose={() => setError(null)} />
    <div className="shop-initialization-steps">
      <div className={pddReady ? 'is-complete' : ''}>
        <span className="shop-initialization-index">1</span>
        <div><strong>拼多多</strong><small>{pddReady ? pddLogin.detail : `应登录：${shop.expectedShopName || shop.name}`}</small></div>
        <StatusBadge status={pddLogin.status} label={pddLogin.label} />
        <button className="button" type="button" disabled={busySystem != null || pddReady} onClick={() => run('pdd', onOpenPdd)}>
          {pddReady ? <CheckCircle2 size={15} /> : <LogIn size={15} />}{busySystem === 'pdd' ? '正在打开...' : pddReady ? '已完成' : '打开拼多多登录'}
        </button>
      </div>
      <div className={omsReady ? 'is-complete' : ''}>
        <span className="shop-initialization-index">2</span>
        <div><strong>OMS</strong><small>{shop.omsCredentialsConfigured ? '已配置本店凭证，Worker 会自动登录并保存会话' : '未配置专属凭证，可在本店独立窗口人工登录一次'}</small></div>
        <StatusBadge status={omsLogin.status} label={omsLogin.label} />
        <button className="button" type="button" disabled={busySystem != null || omsReady} onClick={() => run('oms', onOpenOms)}>
          {omsReady ? <CheckCircle2 size={15} /> : <LogIn size={15} />}{busySystem === 'oms' ? '正在打开...' : omsReady ? '已完成' : '打开 OMS 登录'}
        </button>
      </div>
      <div className={tmsReady ? 'is-complete' : ''}>
        <span className="shop-initialization-index">3</span>
        <div><strong>TMS</strong><small>使用本店 Worker 的独立浏览器会话，已有公共凭证时会自动登录</small></div>
        <StatusBadge status={tmsLogin.status} label={tmsLogin.label} />
        <button className="button" type="button" disabled={busySystem != null || tmsReady} onClick={() => run('tms', onOpenTms)}>
          {tmsReady ? <CheckCircle2 size={15} /> : <LogIn size={15} />}{busySystem === 'tms' ? '正在打开...' : tmsReady ? '已完成' : '打开 TMS 登录'}
        </button>
      </div>
    </div>
    <div className="shop-initialization-note">登录窗口标题会显示店铺名称、店铺编号和系统名称；完成后无需再次配置，后续登录失效时可从店铺卡片重新打开。</div>
    <div className="modal-actions"><button type="button" className="button" onClick={onClose}>{initializationComplete ? '完成' : '稍后继续'}</button></div>
  </Modal>;
}

function ShopForm({
  shop, owner, onClose, onSaved, onError, windowsLocalBrowser, onWorkerBrowserStarting,
}) {
  const [name, setName] = useState(shop?.name || '');
  const [expectedShopName, setExpectedShopName] = useState(shop?.expectedShopName || shop?.name || '');
  const [omsAccount, setOmsAccount] = useState('');
  const [omsPassword, setOmsPassword] = useState('');
  const [enabled, setEnabled] = useState(shop?.enabled ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const editing = Boolean(shop);
  const submit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const loginWindow = editing || !enabled || windowsLocalBrowser ? null : window.open('about:blank', '_blank');
    try {
      const result = await ownerRequest(
        editing ? `/api/v1/shops/${encodeURIComponent(shop.shopId)}` : '/api/v1/shops',
        owner.csrfToken,
        { method: editing ? 'PATCH' : 'POST', body: JSON.stringify({
          name,
          expectedShopName,
          enabled,
          ...(omsAccount || omsPassword ? { omsAccount, omsPassword } : {}),
        }) },
      );
      if (loginWindow) loginWindow.location.href = remoteDesktopUrl(result.data);
      else if (!editing && enabled && windowsLocalBrowser) onWorkerBrowserStarting(result.data);
      else if (!editing && enabled) onError(new Error('店铺已创建，但浏览器拦截了登录窗口。请在店铺卡片中点击“打开远程桌面”。'));
      onSaved(result.data);
      onClose();
    } catch (requestError) {
      loginWindow?.close();
      setError(localBrowserError(requestError));
    } finally {
      setSubmitting(false);
    }
  };
  return <Modal title={editing ? '编辑店铺' : '新增拼多多店铺'} onClose={onClose} width={520}>
    <form className="form-stack" onSubmit={submit}>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <label><span>店铺显示名称</span><input required minLength={2} maxLength={120} value={name} autoFocus onChange={(event) => {
        const previous = name;
        const next = event.target.value;
        setName(next);
        if (!editing && (!expectedShopName || expectedShopName === previous)) setExpectedShopName(next);
      }} /></label>
      <label><span>拼多多店铺名称</span><input required minLength={2} maxLength={120} value={expectedShopName} onChange={(event) => setExpectedShopName(event.target.value)} /></label>
      <div className="form-section-label">OMS 自动登录（可选）</div>
      <label><span>OMS 账号</span><input value={omsAccount} autoComplete="off" onChange={(event) => setOmsAccount(event.target.value)} placeholder="留空则首次在浏览器中人工登录" /></label>
      <label><span>OMS 密码</span><input value={omsPassword} type="password" autoComplete="new-password" onChange={(event) => setOmsPassword(event.target.value)} placeholder="仅保存到服务器 secrets，不回显" /></label>
      <small className="form-help-text">填写完整账号和密码后，店铺 Worker 会自动登录 OMS；未填写时会打开本店独立窗口，等你首次人工登录。</small>
      <label className="checkbox-field"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>启用店铺 Worker</span></label>
      <div className="modal-actions"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" disabled={submitting}>{submitting ? '保存中...' : editing ? '保存配置' : enabled ? '创建并登录' : '创建店铺'}</button></div>
    </form>
  </Modal>;
}

function DeleteShopModal({ shop, owner, onClose, onDeleted }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const remove = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await ownerRequest(`/api/v1/shops/${encodeURIComponent(shop.shopId)}`, owner.csrfToken, {
        method: 'DELETE',
      });
      onDeleted();
      onClose();
    } catch (requestError) {
      setError(requestError.message === 'shop-has-business-data'
        ? new Error('该店铺已经产生业务工单，不能永久删除。请改为停用店铺 Worker。')
        : requestError);
    } finally {
      setSubmitting(false);
    }
  };
  return <Modal title="删除店铺" onClose={onClose} width={480}>
    <div className="delete-shop-confirmation">
      <AlertTriangle size={22} />
      <div><strong>确认删除“{shop.name || shop.shopId}”？</strong><p>将停止该店铺 Worker，并永久删除尚未产生工单的店铺配置与登录状态。</p></div>
    </div>
    <ErrorBanner error={error} onClose={() => setError(null)} />
    <div className="modal-actions"><button type="button" className="button" onClick={onClose} disabled={submitting}>取消</button><button type="button" className="button danger" onClick={remove} disabled={submitting}>{submitting ? '正在删除...' : '确认删除'}</button></div>
  </Modal>;
}

export default function ShopsView({
  shops, owner, isOwner, refresh, refreshVersion, setError, runtime, runtimeCapacity,
}) {
  const [editingShop, setEditingShop] = useState(null);
  const [deletingShop, setDeletingShop] = useState(null);
  const [creating, setCreating] = useState(false);
  const [initializingShopId, setInitializingShopId] = useState(null);
  const [busyShopId, setBusyShopId] = useState(null);
  const [clearingShopId, setClearingShopId] = useState(null);
  const [browserNotice, setBrowserNotice] = useState(null);
  const [activeVerifications, setActiveVerifications] = useState([]);
  const [search, setSearch] = useState('');
  const [heatFilter, setHeatFilter] = useState('');
  const [scheduleFilter, setScheduleFilter] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const windowsLocalBrowser = String(runtime?.platform || '').trim().toLowerCase() === 'windows native';
  const slotScheduler = runtime?.schedulerMode === 'slots';

  useEffect(() => {
    let cancelled = false;
    const load = (reportError = false) => api('/api/v1/verifications?active=true')
      .then((result) => { if (!cancelled) setActiveVerifications(result.data || []); })
      .catch((requestError) => { if (!cancelled && reportError) setError(requestError); });
    load(true);
    const timer = window.setInterval(() => load(false), 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [refreshVersion, setError]);

  const requestLocalBrowser = async (shop) => {
    const result = await ownerRequest(`/api/v1/shops/${encodeURIComponent(shop.shopId)}/browser`, owner.csrfToken, {
      method: 'POST', body: '{}',
    });
    const workerManaged = result.data?.status === 'worker-managed';
    const workerOnline = result.data?.workerOnline === true;
    setBrowserNotice({
      queued: result.data?.status === 'queued' || (workerManaged && !workerOnline),
      message: workerManaged
        ? workerOnline
          ? `“${shop.name || shop.shopId}”浏览器已由店铺 Worker 管理，请直接使用已经打开的窗口。`
          : `“${shop.name || shop.shopId}”店铺 Worker 正在接管浏览器，请稍候再操作。`
        : result.data?.status === 'queued'
        ? `“${shop.name || shop.shopId}”浏览器已排队${result.data?.queuePosition ? `，当前第 ${result.data.queuePosition} 位` : ''}。`
        : `已在 Windows 服务器桌面打开“${shop.name || shop.shopId}”浏览器。`,
    });
    return result.data;
  };

  const openLocalBrowser = async (shop) => {
    setBusyShopId(shop.shopId);
    try {
      return await requestLocalBrowser(shop);
    } catch (requestError) {
      setError(localBrowserError(requestError));
    } finally {
      setBusyShopId(null);
    }
  };

  const updateShop = async (shop, body) => {
    setBusyShopId(shop.shopId);
    try {
      await ownerRequest(`/api/v1/shops/${encodeURIComponent(shop.shopId)}`, owner.csrfToken, {
        method: 'PATCH', body: JSON.stringify(body),
      });
      refresh();
    } catch (requestError) { setError(requestError); } finally { setBusyShopId(null); }
  };

  const openLogin = async (shop) => {
    const loginWindow = windowsLocalBrowser ? null : window.open('about:blank', `pdd-shop-login-${shop.shopId}`);
    setBusyShopId(shop.shopId);
    try {
      const result = await ownerRequest(`/api/v1/shops/${encodeURIComponent(shop.shopId)}/login`, owner.csrfToken, {
        method: 'POST', body: '{}',
      });
      if (windowsLocalBrowser) {
        const launchStatus = result.data.browserLaunch?.status;
        const workerManaged = launchStatus === 'worker-managed';
        const workerOnline = result.data.browserLaunch?.workerOnline === true;
        setBrowserNotice({
          queued: launchStatus === 'queued' || (workerManaged && !workerOnline) || !launchStatus,
          message: launchStatus === 'launched'
            ? `已在服务器桌面打开“${result.data.name || result.data.shopId}”登录窗口。`
            : launchStatus === 'queued'
              ? `“${result.data.name || result.data.shopId}”登录窗口正在启动，请稍候。`
              : workerManaged && workerOnline
                ? `“${result.data.name || result.data.shopId}”登录窗口已由店铺 Worker 管理，请在已经打开的窗口中完成登录。`
                : workerManaged
                  ? `“${result.data.name || result.data.shopId}”店铺 Worker 正在接管浏览器，请稍候再操作。`
              : `“${result.data.name || result.data.shopId}”店铺 Worker 正在重启浏览器，请在已经打开的窗口中完成登录。`,
        });
      }
      else if (loginWindow) loginWindow.location.href = remoteDesktopUrl(result.data);
      refresh();
      return result.data;
    } catch (requestError) {
      loginWindow?.close();
      setError(localBrowserError(requestError));
    } finally { setBusyShopId(null); }
  };
  const openSystemLogin = async (shop, system) => {
    setBusyShopId(shop.shopId);
    try {
      const result = await ownerRequest(`/api/v1/shops/${encodeURIComponent(shop.shopId)}/system-login`, owner.csrfToken, {
        method: 'POST', body: JSON.stringify({ system }),
      });
      const systemLabel = system.toUpperCase();
      setBrowserNotice({
        queued: true,
        message: `正在“${result.data.name || result.data.shopId}”自己的浏览器 Profile 中打开 ${systemLabel} 登录页，不会影响其他店铺账号。`,
      });
      refresh();
      return result.data;
    } catch (requestError) {
      setError(requestError);
    } finally { setBusyShopId(null); }
  };
  const latestVerificationByShop = new Map();
  activeVerifications.forEach((item) => {
    const current = latestVerificationByShop.get(item.shopId);
    if (!current || Date.parse(item.detectedAt || 0) > Date.parse(current.detectedAt || 0)) {
      latestVerificationByShop.set(item.shopId, item);
    }
  });
  const forceClearShopVerification = async (shop, verification) => {
    const orderLabel = verification.workOrderId ? '当前工单' : '当前页面';
    if (!window.confirm(`仅在“${shop.name || shop.shopId}”页面已经没有验证码时使用。确认解除${orderLabel}的验证等待并继续？`)) return;
    setClearingShopId(shop.shopId);
    try {
      await ownerRequest(`/api/v1/verifications/${encodeURIComponent(verification.id)}/force-clear`, owner.csrfToken, {
        method: 'POST',
        body: JSON.stringify({ reason: `所有者从店铺管理确认“${shop.name || shop.shopId}”页面已无验证码，按店铺解除并继续` }),
      });
      setBrowserNotice({
        queued: true,
        message: `“${shop.name || shop.shopId}”已请求解除验证等待，Worker 将继续当前工单。`,
      });
      refresh();
    } catch (requestError) {
      setError(requestError);
    } finally {
      setClearingShopId(null);
    }
  };
  const enabledShopCount = shops.filter((shop) => shop.enabled).length;
  const capacity = shops[0]?.workerCapacity || { enabled: enabledShopCount, limit: null, available: null, unlimited: true };
  const capacityLabel = capacity.unlimited || capacity.limit == null
    ? `已启用 ${capacity.enabled} 家`
    : `容量 ${capacity.enabled}/${capacity.limit}`;
  const onboardingMessage = (shop) => ({
    'waiting-login': windowsLocalBrowser ? '等待在 Windows 服务器桌面完成拼多多登录' : '等待在远程桌面完成拼多多登录',
    initializing: 'Worker 正在准备浏览器',
    ready: '拼多多会话已就绪',
    'identity-mismatch': '当前登录店铺与配置不一致',
    disabled: '店铺已停用',
    error: 'Worker 启动异常',
  }[shop.onboardingStatus] || (shop.enabled ? '配置已同步' : '店铺已停用'));
  const scheduleLabel = (shop) => {
    if (!shop.enabled) return '店铺已停止';
    if (shop.slotKind === 'verification') return '验证码处理中';
    if (shop.slotKind === 'login') return '人工登录窗口';
    if (shop.slotKind) return `业务槽 ${Number(shop.slotIndex) + 1} 运行中`;
    if (shop.scheduleState === 'capacity-blocked') return '容量不足，等待槽位';
    if (shop.scheduleState === 'backoff') return '失败退避等待';
    return shop.queuePosition ? `等待槽位 · 第 ${shop.queuePosition} 位` : '等待下次扫描';
  };
  const filteredShops = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase('zh-CN');
    return shops.filter((shop) => {
      if (keyword && ![shop.name, shop.shopId, shop.expectedShopName]
        .some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(keyword))) return false;
      if (heatFilter && shop.heatState !== heatFilter) return false;
      if (scheduleFilter === 'running' && !shop.slotKind) return false;
      if (scheduleFilter === 'queued' && (shop.slotKind || !shop.enabled)) return false;
      if (scheduleFilter === 'verification' && shop.slotKind !== 'verification') return false;
      if (scheduleFilter === 'login' && shop.slotKind !== 'login') return false;
      if (scheduleFilter === 'overdue' && !shop.overdueReason) return false;
      return true;
    }).sort((left, right) => {
      if (Boolean(left.overdueReason) !== Boolean(right.overdueReason)) {
        return left.overdueReason ? -1 : 1;
      }
      return (left.queuePosition || Number.MAX_SAFE_INTEGER) - (right.queuePosition || Number.MAX_SAFE_INTEGER);
    });
  }, [shops, search, heatFilter, scheduleFilter]);
  const pageCount = Math.max(1, Math.ceil(filteredShops.length / pageSize));
  const visibleShops = filteredShops.slice((Math.min(page, pageCount) - 1) * pageSize, Math.min(page, pageCount) * pageSize);
  const initializingShop = shops.find((shop) => shop.shopId === initializingShopId) || null;

  useEffect(() => setPage(1), [search, heatFilter, scheduleFilter]);

  return <div className="view-stack">
    <div className="view-heading"><div><span className="eyebrow">SHOPS</span><h1>店铺管理</h1><p>{windowsLocalBrowser ? '店铺会话、Windows 本地浏览器与动态 Worker' : '店铺会话、动态 Worker 与处理能力'}</p></div><div className="heading-actions"><span className="section-count">{capacityLabel}</span>{isOwner && <button className="button primary" title="新增并启用店铺" onClick={() => setCreating(true)}><Plus size={16} />新增店铺</button>}</div></div>
    {slotScheduler && runtimeCapacity && <section className="scheduler-capacity-band" aria-label="浏览器调度容量">
      <div><span>启用店铺</span><strong>{runtimeCapacity.enabledShops}</strong><small>{runtimeCapacity.hotShops} 热 / {runtimeCapacity.coldShops} 冷</small></div>
      <div><span>浏览器槽位</span><strong>{runtimeCapacity.slots?.active || 0} / {runtimeCapacity.slots?.target || 0}</strong><small>{runtimeCapacity.slots?.unlimited ? '到期店铺全部并发 · 不限制' : `固定上限 ${runtimeCapacity.slots?.hardLimit}`}</small></div>
      <div><span>到期队列</span><strong>{runtimeCapacity.dueShops || 0}</strong><small>{runtimeCapacity.overdueShops || 0} 家扫描逾期</small></div>
      <div><span>可用内存</span><strong>{Math.round((runtimeCapacity.resources?.freeMemoryMb || 0) / 1024)} GB</strong><small>{({ 'memory-high': '内存较高 · 仅告警', 'memory-emergency': '内存紧张 · 仅告警', 'cpu-high': 'CPU 较高 · 仅告警', 'memory-capacity': '内存低于建议值 · 仅告警' })[runtimeCapacity.resources?.warningReason] || '资源正常 · 不限制启动'}</small></div>
    </section>}
    <section className="filter-band shop-scheduler-filters">
      <div className="search-field"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索店铺名称或编号" /></div>
      <div className="filter-divider" /><Filter size={16} />
      <select value={heatFilter} onChange={(event) => setHeatFilter(event.target.value)}><option value="">全部冷热状态</option><option value="hot">热店</option><option value="cold">冷店</option></select>
      <select value={scheduleFilter} onChange={(event) => setScheduleFilter(event.target.value)}><option value="">全部调度状态</option><option value="running">运行中</option><option value="queued">排队中</option><option value="verification">验证码</option><option value="login">人工登录</option><option value="overdue">扫描逾期</option></select>
    </section>
    {browserNotice && <div className={`browser-launch-banner${browserNotice.queued ? ' queued' : ''}`} role="status">{browserNotice.queued ? <Clock3 size={17} /> : <CheckCircle2 size={17} />}<span>{browserNotice.message}</span><button type="button" className="icon-button" title="关闭" aria-label="关闭" onClick={() => setBrowserNotice(null)}><X size={15} /></button></div>}
    <div className="shop-management-grid">{visibleShops.map((shop) => {
      const pddLogin = pddLoginState(shop);
      const omsLogin = systemLoginState(shop, 'oms');
      const tmsLogin = systemLoginState(shop, 'tms');
      const busy = busyShopId === shop.shopId;
      const activeVerification = latestVerificationByShop.get(shop.shopId);
      const stalePddObservation = pddLogin.status === 'observation-stale';
      const proxyHealth = shop.workerMetadata?.browserProxyHealth;
      const proxyUnavailable = shop.workerMetadata?.state === 'browser-proxy-unavailable'
        || proxyHealth?.ok === false;
      const clearingVerification = clearingShopId === shop.shopId;
      return <article className="shop-management-item" key={shop.shopId}>
        <header><div className="shop-avatar"><Store size={19} /></div><div className="shop-management-title"><strong>{shop.name || shop.shopId}</strong><code>{shop.shopId}</code></div><div className="shop-management-status"><StatusBadge status={pddLogin.status} label={pddLogin.label} /><StatusBadge status={shop.slotKind ? 'worker-online' : slotScheduler ? 'queued' : shop.workerOnline ? 'worker-online' : 'worker-offline'} label={slotScheduler ? scheduleLabel(shop) : undefined} /></div></header>
        <div className={`shop-verification-state ${proxyUnavailable || activeVerification || stalePddObservation ? 'is-blocked' : 'is-clear'}`} role="status">
          {proxyUnavailable ? <WifiOff size={18} /> : activeVerification ? <AlertTriangle size={18} /> : stalePddObservation ? <Clock3 size={18} /> : <CheckCircle2 size={18} />}
          <span>
            <strong>{proxyUnavailable ? '当前代理不可用' : activeVerification ? '当前卡在验证码' : stalePddObservation ? '页面状态待更新' : '当前无验证码阻塞'}</strong>
            <small>{proxyUnavailable
              ? `自动处理已暂停${proxyHealth?.retryAt ? ` · 下次检测 ${formatDateTime(proxyHealth.retryAt)}` : ''}`
              : activeVerification
              ? `${String(activeVerification.system || 'pdd').toUpperCase()} · ${activeVerification.stage || '等待人工验证'} · 检测于 ${formatDateTime(activeVerification.detectedAt)}`
              : stalePddObservation
              ? '等待 Worker 更新页面观察，暂不能确认自动处理状态'
              : '无需点击解除，Worker 可正常继续处理'}</small>
          </span>
        </div>
        <div className="shop-management-fields">
          <div><span>拼多多登录</span><strong>{pddLogin.label}</strong><small><StatusBadge status={pddLogin.status} label={pddLogin.label} /> {pddLogin.detail}</small>{pddLogin.error && <small className="shop-identity-error">{pddLogin.error}</small>}</div>
          <div><span>OMS / TMS 登录</span><strong><StatusBadge status={omsLogin.status} label={`OMS ${omsLogin.label}`} /> <StatusBadge status={tmsLogin.status} label={`TMS ${tmsLogin.label}`} /></strong><small>OMS 使用本店独立账号和 Profile；{shop.omsCredentialsConfigured ? '已配置自动登录凭证' : '未配置凭证，首次需人工登录'}；TMS 使用公共配置</small></div>
          <div><span>业务场景</span><div className="scenario-chip-list">{(shop.scenarioCodes || []).map((code) => <span key={code}>{labelScenario(code)}</span>)}</div></div>
          <div><span>调度与扫描</span><strong>{slotScheduler ? scheduleLabel(shop) : shop.workerId || '等待调度'}</strong><small>{slotScheduler ? `${shop.heatState === 'cold' ? '冷店' : '热店'} · 普通 ${formatDateTime(shop.nextOrdinaryScanAt)} · 退款 ${formatDateTime(shop.nextRefundScanAt)}` : shop.heartbeatAt ? `心跳 ${formatDateTime(shop.heartbeatAt)}` : '尚无心跳'}</small></div>
          <div><span>登录与配置</span><strong>{proxyUnavailable ? '代理不可用，自动处理已暂停' : ({ 'verification-waiting': '验证码导致扫描逾期', 'login-required': '登录失效导致扫描逾期', 'business-processing': '业务处理中', 'scheduler-not-running': '调度器尚未运行', 'worker-offline': 'Worker 未运行，扫描已暂停' })[shop.overdueReason] || shop.capacityBlockedReason || shop.onboardingError || onboardingMessage(shop)}</strong><small>{shop.slotExpiresAt ? `槽位保留至 ${formatDateTime(shop.slotExpiresAt)}` : `配置 v${shop.configVersion || 1} · ${formatDateTime(shop.configUpdatedAt)}`}</small></div>
        </div>
        <footer>
          <span className={`worker-indicator ${runtimeTone((shop.slotKind || shop.workerOnline) ? 'worker-online' : shop.overdueReason ? 'worker-offline' : 'queued')}`}><ServerCog size={14} />{slotScheduler ? scheduleLabel(shop) : shop.workerOnline ? 'Worker 正常运行' : shop.enabled ? 'Worker 正在启动' : 'Worker 已停止'}</span>
          <div className="shop-management-actions">
            {windowsLocalBrowser
              ? <button className="button" type="button" disabled={!isOwner || busy} onClick={() => openLocalBrowser(shop)} title={isOwner ? '在 Windows 服务器桌面打开此店铺浏览器' : '请先登录系统所有者'}><MonitorUp size={15} />打开浏览器</button>
              : shop.workerOnline
                ? <a className="icon-button" href={remoteDesktopUrl(shop)} target="_blank" rel="noopener" referrerPolicy="same-origin" title="打开远程桌面" aria-label="打开远程桌面"><ExternalLink size={16} /></a>
                : <button className="icon-button" type="button" disabled title="Worker 启动后可打开远程桌面" aria-label="远程桌面尚未就绪"><ExternalLink size={16} /></button>}
            {isOwner && <button className="button" disabled={busy} onClick={() => setEditingShop(shop)}><Pencil size={15} />编辑</button>}
            {isOwner && (pddLogin.status !== 'authenticated' || omsLogin.status !== 'authenticated' || tmsLogin.status !== 'authenticated') && <button className="button" disabled={busy} onClick={() => setInitializingShopId(shop.shopId)} title="继续该店铺的拼多多、OMS 与 TMS 初始化"><Workflow size={15} />初始化登录</button>}
            {isOwner && <button className="button" disabled={busy} onClick={() => openLogin(shop)} title="仅登录并校验此店铺的拼多多账号"><LogIn size={15} />{pddLogin.status === 'authenticated' ? '拼多多重登' : '登录拼多多'}</button>}
            {isOwner && <button className="button" disabled={busy} onClick={() => openSystemLogin(shop, 'oms')} title={`在“${shop.name || shop.shopId}”独立 Profile 中登录 OMS`}><LogIn size={15} />{omsLogin.status === 'authenticated' ? 'OMS 重登' : '登录 OMS'}</button>}
            {isOwner && ['expired', 'verification-required'].includes(tmsLogin.status) && <button className="button" disabled={busy} onClick={() => openSystemLogin(shop, 'tms')} title={`在“${shop.name || shop.shopId}”浏览器中登录 TMS`}><LogIn size={15} />登录 TMS</button>}
            {isOwner && <button className={`button ${activeVerification?.workOrderId && !proxyUnavailable ? 'verification-action' : ''}`} disabled={busy || clearingVerification || proxyUnavailable || !activeVerification?.workOrderId} onClick={() => forceClearShopVerification(shop, activeVerification)} title={proxyUnavailable ? '代理恢复后再解除验证码' : activeVerification?.workOrderId ? '解除该店铺当前验证码等待并继续工单' : '当前无验证码阻塞，无需解除'}><LockOpen size={15} />{clearingVerification ? '解除中...' : activeVerification?.workOrderId ? '解除验证并继续' : '无需解除验证'}</button>}
            {isOwner && <button className="icon-button" disabled={busy} onClick={() => updateShop(shop, { enabled: !shop.enabled })} title={shop.enabled ? '停用店铺 Worker' : '启用店铺 Worker'} aria-label={shop.enabled ? '停用店铺 Worker' : '启用店铺 Worker'}>{shop.enabled ? <PowerOff size={16} /> : <Power size={16} />}</button>}
            {isOwner && <button className="icon-button danger-action" disabled={busy} onClick={() => setDeletingShop(shop)} title="删除店铺" aria-label="删除店铺"><Trash2 size={16} /></button>}
          </div>
        </footer>
      </article>;
    })}</div>
    {!filteredShops.length && <section className="section-block empty-state"><Workflow size={28} /><strong>{shops.length ? '没有符合条件的店铺' : '暂无店铺'}</strong></section>}
    {filteredShops.length > pageSize && <div className="pagination"><button className="icon-button" aria-label="上一页" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={18} /></button><span>{Math.min(page, pageCount)} / {pageCount} · 共 {filteredShops.length} 家</span><button className="icon-button" aria-label="下一页" disabled={page >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}><ChevronRight size={18} /></button></div>}
    {(creating || editingShop) && <ShopForm shop={editingShop} owner={owner} onClose={() => { setCreating(false); setEditingShop(null); }} onSaved={(savedShop) => { if (creating && savedShop.enabled) setInitializingShopId(savedShop.shopId); refresh(); }} onError={setError} windowsLocalBrowser={windowsLocalBrowser} onWorkerBrowserStarting={(shop) => setBrowserNotice({ queued: true, message: `“${shop.name || shop.shopId}”店铺 Worker 正在启动浏览器，请在打开的窗口中完成登录。` })} />}
    {initializingShop && <ShopInitializationModal shop={initializingShop} onClose={() => setInitializingShopId(null)} onOpenPdd={openLocalBrowser} onOpenOms={(shop) => openSystemLogin(shop, 'oms')} onOpenTms={(shop) => openSystemLogin(shop, 'tms')} refresh={refresh} />}
    {deletingShop && <DeleteShopModal shop={deletingShop} owner={owner} onClose={() => setDeletingShop(null)} onDeleted={() => refresh()} />}
  </div>;
}
