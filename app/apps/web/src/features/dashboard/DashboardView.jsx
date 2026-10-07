import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, Bot, CheckCircle2, ChevronRight, CircleGauge, Clock3, DatabaseZap, FilePenLine,
  ScanLine, Store, UserRoundCheck,
} from 'lucide-react';
import { api, toQuery } from '../../services/api.js';
import { EmptyState, LoadingBlock, StatusBadge } from '../../components/Common.jsx';
import {
  formatDateTime, labelScenario, labelShop, labelStage, pddLoginState, runtimeTone,
} from '../../app/format.js';

const ownerMetricDefinitions = [
  ['工单总量', 'total', DatabaseZap, 'neutral'],
  ['严格自动化成功', 'strictAutoSuccess', Bot, 'success'],
  ['其中人工协助', 'humanConfirmed', UserRoundCheck, 'warning'],
  ['处理中', 'processing', Activity, 'info'],
  ['等待中', 'waiting', Clock3, 'warning'],
  ['已暂停', 'paused', FilePenLine, 'neutral'],
  ['异常中断', 'failed', AlertTriangle, 'danger'],
  ['等待验证', 'verification', ScanLine, 'warning'],
];
const viewerMetricDefinitions = [
  ['工单总量', 'total', DatabaseZap, 'neutral'],
  ['自动化成功', 'autoSuccess', Bot, 'success'],
  ['处理中', 'processing', Activity, 'info'],
  ['等待中', 'waiting', Clock3, 'warning'],
  ['已暂停', 'paused', FilePenLine, 'neutral'],
  ['异常中断', 'failed', AlertTriangle, 'danger'],
  ['等待验证', 'verification', ScanLine, 'warning'],
  ['未成功', 'notSuccessful', AlertTriangle, 'danger'],
];
const shopRuntimeStale = (shop) => {
  const hasLiveTelemetry = shop.workerOnline !== undefined
    || shop.heartbeatAgeSeconds != null;
  if (!hasLiveTelemetry) return !shop.lastSyncedAt || Number(shop.syncLagSeconds) > 15;
  return shop.workerOnline !== true
    || !Number.isFinite(Number(shop.heartbeatAgeSeconds))
    || Number(shop.heartbeatAgeSeconds) > 60;
};
export default function DashboardView({
  summary, shops, scenarios, filters, refreshVersion, loading, setError,
  settings, isOwner, updateReturnRefundSettings, onOpenWorkOrders,
}) {
  const [logs, setLogs] = useState([]);
  useEffect(() => {
    api(`/api/v1/logs?${toQuery({ ...filters, pageSize: 8 })}`).then((result) => setLogs(result.data || [])).catch(setError);
  }, [filters, refreshVersion, setError]);
  const milestoneSuccessCount = Number(summary.autoSuccess) || 0;
  const pureAutomationCount = Number(summary.strictAutoSuccess) || 0;
  const assistedSuccessCount = Number(summary.humanConfirmed) || 0;
  const successCount = isOwner ? pureAutomationCount : milestoneSuccessCount;
  const notSuccessfulCount = isOwner
    ? Math.max(0, Number(summary.total || 0) - pureAutomationCount)
    : Number(summary.notSuccessful)
      || Math.max(0, Number(summary.total || 0) - milestoneSuccessCount);
  const automationRate = summary.total ? Math.round((successCount / Number(summary.total)) * 100) : 0;
  const visibleMetricDefinitions = isOwner ? ownerMetricDefinitions : viewerMetricDefinitions;
  const scenarioRows = useMemo(() => {
    const byCode = new Map((summary.byScenario || []).map((item) => [item.scenarioCode, item]));
    const definitions = (scenarios || [])
      .filter((item) => item.enabled !== false)
      .map((item, index) => ({ ...item, displayOrder: Number(item.displayOrder ?? 999), sourceOrder: index }))
      .sort((left, right) => left.displayOrder - right.displayOrder || left.sourceOrder - right.sourceOrder);
    const definitionsByCode = new Map(definitions.map((item) => [item.code, item]));
    const selectedCodes = filters.scenarioCode
      ? [filters.scenarioCode]
      : [
        ...definitions.map((item) => item.code),
        ...[...byCode.keys()].filter((code) => !definitionsByCode.has(code)),
      ];
    return selectedCodes.map((code) => ({
      scenarioCode: code,
      displayName: definitionsByCode.get(code)?.displayName || labelScenario(code),
      displayOrder: definitionsByCode.get(code)?.displayOrder ?? 999,
      total: 0,
      autoSuccess: 0,
      strictAutoSuccess: 0,
      humanConfirmed: 0,
      manualReview: 0,
      notSuccessful: 0,
      excludedWaiting: 0,
      ...(byCode.get(code) || {}),
    }));
  }, [filters.scenarioCode, scenarios, summary.byScenario]);
  const scenarioMax = useMemo(() => Math.max(1, ...scenarioRows.map((item) => item.total || 0)), [scenarioRows]);
  const refundOnly = filters.scenarioCode === 'return-refund';
  const enabledShops = shops.filter((shop) => shop.enabled !== false);
  const visibleShops = refundOnly
    ? enabledShops.filter((shop) => shop.scenarioCodes?.includes('return-refund'))
    : enabledShops;
  const staleShops = visibleShops.filter(shopRuntimeStale);

  return <div className="view-stack">
    <div className="view-heading"><div><span className="eyebrow">OVERVIEW</span><h1>运营总览</h1><p>{refundOnly ? `${visibleShops.length} 家已配置店铺的 PDD 退货退款业务状态` : `${visibleShops.length} 家店铺 PDD、OMS、TMS 实时业务状态`}</p></div><div className="rate-summary"><CircleGauge size={22} /><div><strong>{automationRate}%</strong><span>{isOwner ? '严格自动化率' : '自动化成功率'}</span></div></div></div>
    {staleShops.length > 0 && <div className="sync-warning" role="status"><AlertTriangle size={17} /><strong>数据同步延迟</strong><span>{staleShops.map((shop) => labelShop(shop)).join('、')}</span></div>}
    {loading ? <LoadingBlock /> : <>
      <section className="metrics-grid">{visibleMetricDefinitions.map(([label, key, Icon, tone]) => <button type="button" className={`metric-tile ${tone}`} key={key} onClick={() => onOpenWorkOrders({ metric: key })}><div className="metric-icon"><Icon size={19} /></div><div><span>{label}</span><strong>{key === 'notSuccessful' ? notSuccessfulCount : summary[key] ?? 0}</strong></div><ChevronRight className="metric-drilldown-icon" size={15} /></button>)}</section>

      <div className="dashboard-grid">
        <section className="section-block scenario-section"><div className="section-heading"><div><h2>业务场景分布</h2><span>{scenarioRows.length} 个业务场景</span></div>{isOwner && <div className="refund-runtime-controls"><label><span>退款扫描</span><input type="checkbox" checked={settings?.returnRefundScanEnabled === true} onChange={(event) => updateReturnRefundSettings({ scanEnabled: event.target.checked })} /><i aria-hidden="true" /></label><label><span>自动退款</span><input type="checkbox" checked={settings?.returnRefundAutoApproveEnabled === true} onChange={(event) => updateReturnRefundSettings({ autoApproveEnabled: event.target.checked })} /><i aria-hidden="true" /></label></div>}</div>
          {scenarioRows.length ? <div className="scenario-list">{scenarioRows.map((row) => {
            const isRefund = row.scenarioCode === 'return-refund';
            const rateNumerator = isOwner ? Number(row.strictAutoSuccess || 0) : Number(row.autoSuccess || 0);
            const rate = row.total ? Math.round((rateNumerator / Number(row.total)) * 100) : 0;
            const notSuccessful = isOwner
              ? Math.max(0, Number(row.total || 0) - Number(row.strictAutoSuccess || 0))
              : row.notSuccessful ?? Math.max(0, Number(row.total || 0) - Number(row.autoSuccess || 0));
            return <div className={`scenario-row${isRefund ? ' refund-scenario' : ''}`} key={row.scenarioCode}>
              <button type="button" className="scenario-name scenario-drilldown" onClick={() => onOpenWorkOrders({ metric: isOwner ? 'total' : 'autoSuccess', scenarioCode: row.scenarioCode })}><strong>{row.displayName}</strong><span>{row.scenarioCode}</span></button>
              <div className="scenario-progress"><div className="scenario-bar"><span style={{ width: `${row.total ? Math.max(3, (row.total / scenarioMax) * 100) : 0}%` }} /></div></div>
              {!isOwner
                ? <div className="scenario-stats viewer"><button type="button" className="text-success" onClick={() => onOpenWorkOrders({ metric: 'autoSuccess', scenarioCode: row.scenarioCode })}><strong>{row.autoSuccess}</strong>自动化成功</button><button type="button" className="text-danger" onClick={() => onOpenWorkOrders({ metric: 'notSuccessful', scenarioCode: row.scenarioCode })}><strong>{notSuccessful}</strong>未成功</button></div>
                : isRefund
                ? <><div className="scenario-refund-spacer" aria-hidden="true" /><div className="refund-metrics">
                  <button type="button" onClick={() => onOpenWorkOrders({ metric: 'total', scenarioCode: row.scenarioCode })}><b>{row.total}</b>订单</button>
                  <button type="button" className="text-success" onClick={() => onOpenWorkOrders({ metric: 'refundAutoSuccess', scenarioCode: row.scenarioCode })}><b>{row.refundAutoSuccess ?? 0}</b>自动退款</button>
                  <button type="button" className="text-warning" onClick={() => onOpenWorkOrders({ metric: 'refundManualCompleted', scenarioCode: row.scenarioCode })}><b>{row.refundManualCompleted ?? 0}</b>人工协助</button>
                  <span><b>{rate}%</b>成功率</span>
                  <button type="button" className="text-danger" onClick={() => onOpenWorkOrders({ metric: 'notSuccessful', scenarioCode: row.scenarioCode })}><b>{notSuccessful}</b>尚未成功</button>
                  <button type="button" className="refund-waiting-count" onClick={() => onOpenWorkOrders({ metric: 'returnRefundWaiting', scenarioCode: row.scenarioCode })}><Clock3 size={12} /><b>{Number(row.excludedWaiting || 0)}</b>等待中工单</button>
                </div></>
                : <div className="scenario-stats"><button type="button" onClick={() => onOpenWorkOrders({ metric: 'total', scenarioCode: row.scenarioCode })}><strong>{row.total}</strong></button><button type="button" className="text-success" onClick={() => onOpenWorkOrders({ metric: 'strictAutoSuccess', scenarioCode: row.scenarioCode })}>严格自动 {row.strictAutoSuccess}</button><span className="scenario-success-breakdown"><button type="button" onClick={() => onOpenWorkOrders({ metric: 'autoSuccess', scenarioCode: row.scenarioCode })}>宽松完成 {row.autoSuccess}</button><button type="button" className="text-warning" onClick={() => onOpenWorkOrders({ metric: 'humanConfirmed', scenarioCode: row.scenarioCode })}>协助 {row.humanConfirmed}</button></span></div>}
            </div>;
          })}</div> : <EmptyState title="当前范围暂无场景数据" />}
        </section>

        <section className="section-block automation-section"><div className="section-heading"><div><h2>{isOwner ? '严格处理结构' : '自动化结果'}</h2><span>{isOwner ? '完整平台确认且无人工作业' : '自动化成功与未成功'}</span></div></div><div className="donut-layout"><div className="donut" style={{ '--rate': `${automationRate * 3.6}deg` }}><div><strong>{automationRate}%</strong><span>{isOwner ? '严格自动化率' : '自动化成功率'}</span></div></div><div className="legend-list">{isOwner ? <><button type="button" onClick={() => onOpenWorkOrders({ metric: 'strictAutoSuccess' })}><span className="legend-dot green" />严格自动化成功<strong>{pureAutomationCount}</strong></button><button type="button" onClick={() => onOpenWorkOrders({ metric: 'autoSuccess' })}><span className="legend-dot neutral" />业务里程碑完成<strong>{milestoneSuccessCount}</strong></button><button type="button" onClick={() => onOpenWorkOrders({ metric: 'humanConfirmed' })}><span className="legend-dot amber" />人工协助完成<strong>{assistedSuccessCount}</strong></button></> : <button type="button" onClick={() => onOpenWorkOrders({ metric: 'autoSuccess' })}><span className="legend-dot green" />自动化成功<strong>{successCount}</strong></button>}<button type="button" onClick={() => onOpenWorkOrders({ metric: isOwner ? 'notStrictSuccessful' : 'notSuccessful' })}><span className="legend-dot red" />{isOwner ? '尚未严格完成' : '未成功'}<strong>{notSuccessfulCount}</strong></button></div></div></section>
      </div>

      <section className="section-block"><div className="section-heading"><div><h2>店铺运行健康度</h2><span>{refundOnly ? 'PDD 会话与退款扫描检查点' : '会话、系统标签与同步检查点'}</span></div><span className="section-count">{visibleShops.length} 家店铺</span></div>
        <div className="shop-health-grid">{visibleShops.map((shop) => {
          const auth = shop.authHealth || {};
          const pddLogin = pddLoginState(shop);
          const activeStatus = shop.runtimeStatus || 'queued';
          const syncStale = shopRuntimeStale(shop);
          const systems = refundOnly ? ['pdd'] : ['pdd', 'oms', 'tms'];
          return <article className="shop-health" key={shop.shopId}><div className="shop-health-title"><div className="shop-avatar"><Store size={18} /></div><div><strong>{labelShop(shop)}</strong><span>{shop.shopId}</span></div><StatusBadge status={activeStatus} /></div><div className={`system-health${refundOnly ? ' refund-only' : ''}`}>{systems.map((system) => {
            const health = auth[system] || {};
            const display = system === 'pdd'
              ? pddLogin
              : health.status === 'authenticated'
                ? { status: health.status, label: '已登录' }
                : health.status === 'expired'
                  ? { status: health.status, label: '需要登录' }
                  : health.status === 'unreachable'
                    ? { status: health.status, label: '连接异常' }
                  : health.status === 'verification-required'
                    ? { status: health.status, label: '待验证' }
                    : { status: health.status || 'unknown', label: '待检测' };
            return <div key={system} title={system === 'pdd' ? pddLogin.detail : undefined}><span>{system.toUpperCase()}</span><StatusBadge status={display.status} label={display.label} /></div>;
          })}</div><div className="shop-current"><span>当前阶段</span><strong>{labelStage(shop.step)}</strong><small>{pddLogin.status === 'identity-mismatch' ? pddLogin.detail : shop.currentOrderNumber || '当前无占用工单'}</small></div><div className="shop-health-foot"><span>最近业务活动 {formatDateTime(shop.updatedAt)}</span><span className={`sync-mark ${syncStale ? 'stale' : ''}`}><span />{syncStale ? '运行状态暂未更新' : '状态正常'}</span></div></article>;
        })}</div>
      </section>

      <section className="section-block"><div className="section-heading"><div><h2>最近运行日志</h2><span>Worker 状态写入与异常定位</span></div><span className="live-label"><span />LIVE</span></div>
        {logs.length ? <div className="log-stream">{logs.map((log) => <div className="log-line" key={log.id}><time>{formatDateTime(log.occurredAt)}</time><span className={`log-level ${runtimeTone(log.severity === 'error' ? 'failed' : log.severity === 'warning' ? 'waiting' : 'processing')}`}>{log.severity || 'info'}</span><strong>{String(log.system || 'pdd').toUpperCase()}</strong><span>{labelShop(log.shopId)}</span><code>{labelStage(log.stage)}</code><p>{log.message || log.reasonCode || log.eventType}</p></div>)}</div> : <EmptyState title="当前范围暂无运行日志" />}
      </section>
    </>}
  </div>;
}
