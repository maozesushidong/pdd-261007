import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowUpDown, Bot, CalendarDays, ChevronLeft, ChevronRight,
  CircleAlert, CircleGauge, ClipboardList, Clock3, DatabaseZap, Filter, Layers3,
  LayoutDashboard, RefreshCw, ScanLine, Search, Store, UserRoundCheck,
} from 'lucide-react';
import { EmptyState, ErrorBanner, IconButton, LoadingBlock, StatusBadge } from '../components/Common.jsx';
import PublicVerificationView from '../components/PublicVerificationView.jsx';
import PublicWorkOrderDrawer from '../components/PublicWorkOrderDrawer.jsx';
import { formatDateTime, labelScenario, labelShop, labelStage, publicSystemLoginState } from './format.js';
import { publicApi } from '../services/public-api.js';

const beijingToday = () => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};
const pollIntervalMs = 15_000;

const navigation = [
  { id: 'dashboard', label: '运营总览', icon: LayoutDashboard },
  { id: 'work-orders', label: '工单中心', icon: ClipboardList },
  { id: 'manual-review', label: '转人工', icon: UserRoundCheck },
  { id: 'verification', label: '验证定位', icon: ScanLine },
  { id: 'shops', label: '店铺状态', icon: Store },
];

const publicAssetBase = window.location.pathname.startsWith('/public')
  ? '/public/'
  : (import.meta.env.BASE_URL || '/');

const metricDefinitions = [
  ['工单总量', 'total', DatabaseZap, 'neutral'],
  ['自动化成功', 'autoSuccess', Bot, 'success'],
  ['处理中', 'processing', Activity, 'info'],
  ['等待中', 'waiting', Clock3, 'warning'],
  ['已暂停', 'paused', AlertTriangle, 'neutral'],
  ['异常中断', 'failed', AlertTriangle, 'danger'],
  ['转人工', 'manualReview', UserRoundCheck, 'warning'],
  ['等待验证', 'verification', UserRoundCheck, 'warning'],
  ['未成功', 'notSuccessful', CircleAlert, 'danger'],
];

const workOrderMetrics = [
  ['total', '工单总量'], ['autoSuccess', '自动化成功'], ['processing', '处理中'],
  ['waiting', '等待中'], ['paused', '已暂停'], ['failed', '异常中断'],
  ['manualReview', '转人工'], ['verification', '等待验证'], ['notSuccessful', '未成功'],
];

const toQuery = (values) => {
  const query = new URLSearchParams();
  Object.entries(values || {}).forEach(([key, value]) => {
    if (value !== '' && value != null) query.set(key, String(value));
  });
  return query.toString();
};

function systemState(shop, system) {
  return publicSystemLoginState(shop.authHealth?.[system]);
}

const shopRuntimeStale = (shop) => {
  const hasLiveTelemetry = shop.workerOnline !== undefined
    || shop.heartbeatAgeSeconds != null;
  if (!hasLiveTelemetry) return !shop.lastSyncedAt || Number(shop.syncLagSeconds) > 15;
  return shop.workerOnline !== true
    || !Number.isFinite(Number(shop.heartbeatAgeSeconds))
    || Number(shop.heartbeatAgeSeconds) > 60;
};

function ShopHealth({ shop }) {
  const syncStale = shopRuntimeStale(shop);
  return <article className="shop-health">
    <div className="shop-health-title"><div className="shop-avatar"><Store size={18} /></div><div><strong>{labelShop(shop)}</strong><span>{shop.shopId}</span></div><StatusBadge status="processing" label="处理中" /></div>
    <div className="system-health">{['pdd', 'oms', 'tms'].map((system) => { const state = systemState(shop, system); return <div key={system}><span>{system.toUpperCase()}</span><StatusBadge status={state.status} label={state.label} /></div>; })}</div>
    <div className="shop-current"><span>当前阶段</span><strong>{labelStage(shop.step)}</strong><small>{shop.currentOrderNumber || '当前无占用工单'}</small></div>
    <div className="shop-health-foot"><span>最近业务活动 {formatDateTime(shop.updatedAt)}</span><span className={`sync-mark ${syncStale ? 'stale' : ''}`}><span />{syncStale ? '运行状态暂未更新' : '状态正常'}</span></div>
  </article>;
}

const trendDayMs = 24 * 60 * 60 * 1000;
const trendDateValue = (value) => {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
};
const trendDateText = (date) => date.toISOString().slice(0, 10);
const trendAddDays = (date, days) => new Date(date.getTime() + days * trendDayMs);
const trendStartOfWeek = (date) => {
  const day = date.getUTCDay();
  return trendAddDays(date, day === 0 ? -6 : 1 - day);
};
const trendLabel = (date, granularity) => {
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  if (granularity === 'month') return `${date.getUTCFullYear()}-${month}`;
  if (granularity === 'week') return `${month}-${day}`;
  return `${month}-${day}`;
};
const buildTrendBuckets = (from, to, granularity) => {
  const start = trendDateValue(from);
  const end = trendDateValue(to);
  if (!start || !end || start > end) return [];
  const buckets = [];
  let cursor = granularity === 'week' ? trendStartOfWeek(start) : granularity === 'month'
    ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)) : start;
  while (cursor <= end) {
    const next = granularity === 'day'
      ? trendAddDays(cursor, 1)
      : granularity === 'week'
        ? trendAddDays(cursor, 7)
        : new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const queryFrom = cursor < start ? start : cursor;
    const queryToDate = trendAddDays(next, -1) > end ? end : trendAddDays(next, -1);
    buckets.push({
      key: trendDateText(cursor),
      label: trendLabel(cursor, granularity),
      from: trendDateText(queryFrom),
      to: trendDateText(queryToDate),
    });
    cursor = next;
  }
  return buckets;
};

function WorkOrderTrend({ filters, refreshVersion }) {
  const [granularity, setGranularity] = useState('day');
  const [trend, setTrend] = useState({ status: 'loading', points: [], error: null });
  const [reloadVersion, setReloadVersion] = useState(0);
  const buckets = useMemo(() => buildTrendBuckets(filters.from, filters.to, granularity), [filters.from, filters.to, granularity]);
  const daySpan = useMemo(() => {
    const start = trendDateValue(filters.from);
    const end = trendDateValue(filters.to);
    return start && end ? Math.floor((end.getTime() - start.getTime()) / trendDayMs) + 1 : 0;
  }, [filters.from, filters.to]);
  const maxDaysByGranularity = granularity === 'day' ? 93 : granularity === 'week' ? 370 : 1095;

  useEffect(() => {
    let cancelled = false;
    if (!buckets.length) {
      setTrend({ status: 'empty', points: [], error: null });
      return () => { cancelled = true; };
    }
    if (daySpan > maxDaysByGranularity) {
      setTrend({ status: 'range', points: [], error: null });
      return () => { cancelled = true; };
    }
    setTrend({ status: 'loading', points: [], error: null });
    Promise.all(buckets.map((bucket) => publicApi(`/api/v1/metrics/summary?${toQuery({ ...filters, from: bucket.from, to: bucket.to })}`)))
      .then((results) => {
        if (cancelled) return;
        setTrend({
          status: 'ready',
          error: null,
          points: buckets.map((bucket, index) => {
            const summary = results[index]?.data || {};
            return {
              ...bucket,
              total: Number(summary.total || 0),
              completed: Number(summary.autoSuccess || 0),
            };
          }),
        });
      })
      .catch((error) => !cancelled && setTrend({ status: 'error', points: [], error }));
    return () => { cancelled = true; };
  }, [buckets, daySpan, filters, maxDaysByGranularity, refreshVersion, reloadVersion]);

  const points = trend.points;
  const totals = useMemo(() => points.reduce((result, point) => ({
    total: result.total + point.total,
    completed: result.completed + point.completed,
  }), { total: 0, completed: 0 }), [points]);
  const incomplete = Math.max(0, totals.total - totals.completed);
  const completionRate = totals.total ? Math.round((totals.completed / totals.total) * 100) : 0;
  const maxValue = Math.max(1, ...points.flatMap((point) => [point.total, point.completed]));
  const plot = { left: 42, right: 738, top: 20, bottom: 202 };
  const pointAt = (value, index) => {
    const x = points.length <= 1 ? (plot.left + plot.right) / 2 : plot.left + (index / (points.length - 1)) * (plot.right - plot.left);
    const y = plot.bottom - (value / maxValue) * (plot.bottom - plot.top);
    return { x, y };
  };
  const pathFor = (key) => points.map((point, index) => {
    const item = pointAt(point[key], index);
    return `${index ? 'L' : 'M'} ${item.x.toFixed(2)} ${item.y.toFixed(2)}`;
  }).join(' ');
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const hoveredPoint = hoveredIndex == null ? null : points[hoveredIndex];
  const hoveredLeft = hoveredIndex == null || points.length <= 1 ? 50 : Math.min(94, Math.max(6, (hoveredIndex / (points.length - 1)) * 100));

  return <section className="section-block trend-section">
    <div className="section-heading trend-heading"><div><h2>工单趋势</h2><span>按时间查看工单总量与完成进度</span></div><div className="trend-controls" role="group" aria-label="时间粒度"><span>时间粒度</span>{[['day', '日'], ['week', '周'], ['month', '月']].map(([value, label]) => <button type="button" key={value} className={granularity === value ? 'active' : ''} onClick={() => setGranularity(value)}>{label}</button>)}</div></div>
    {trend.status === 'range' ? <div className="trend-inline-state warning" role="status"><AlertTriangle size={17} /><span>当前日期范围较大，建议缩小到 {granularity === 'day' ? '93' : granularity === 'week' ? '370' : '1095'} 天以内再查看趋势。</span></div>
        : trend.status === 'error' ? <div className="trend-inline-state error" role="alert"><AlertTriangle size={17} /><span>趋势数据加载失败，请刷新后重试。</span><button type="button" className="button" onClick={() => setReloadVersion((value) => value + 1)}>刷新</button></div>
        : trend.status === 'loading' ? <LoadingBlock label="趋势数据加载中" />
          : trend.status === 'empty' || !points.some((point) => point.total > 0) ? <EmptyState title="当前范围暂无趋势数据" detail="调整店铺、业务场景或日期范围后重试" />
            : <>
              <div className="trend-metrics" aria-label="趋势汇总指标"><div><span>工单总量</span><strong>{totals.total}</strong></div><div className="completed"><span>已完成量</span><strong>{totals.completed}</strong></div><div className="incomplete"><span>未完成量</span><strong>{incomplete}</strong></div><div className="rate"><span>完成率</span><strong>{completionRate}%</strong></div></div>
              <div className="trend-chart-shell"><div className="trend-legend"><span><i className="total" />工单总量</span><span><i className="completed" />已完成量</span></div><svg className="trend-chart" viewBox="0 0 760 250" role="img" aria-label="工单总量与已完成量时间趋势折线图">
                {[0, 0.5, 1].map((ratio) => { const y = plot.bottom - ratio * (plot.bottom - plot.top); return <g key={ratio}><line x1={plot.left} x2={plot.right} y1={y} y2={y} className="trend-grid-line" /><text x={plot.left - 10} y={y + 4} textAnchor="end" className="trend-axis-label">{Math.round(maxValue * ratio)}</text></g>; })}
                <path d={pathFor('total')} className="trend-line total" />
                <path d={pathFor('completed')} className="trend-line completed" />
                {points.map((point, index) => { const totalPoint = pointAt(point.total, index); const completedPoint = pointAt(point.completed, index); return <g key={point.key} className="trend-point-group" onMouseEnter={() => setHoveredIndex(index)} onMouseLeave={() => setHoveredIndex(null)} onFocus={() => setHoveredIndex(index)} onBlur={() => setHoveredIndex(null)}><circle cx={totalPoint.x} cy={totalPoint.y} r="4" className="trend-point total" /><circle cx={completedPoint.x} cy={completedPoint.y} r="4" className="trend-point completed" /><circle cx={totalPoint.x} cy={totalPoint.y} r="13" className="trend-hover-target" tabIndex="0" aria-label={`${point.label} 工单总量 ${point.total}，已完成 ${point.completed}`} /></g>; })}
                {points.map((point, index) => { const x = pointAt(0, index).x; const show = points.length <= 8 || index === 0 || index === points.length - 1 || index % Math.ceil(points.length / 6) === 0; return show ? <text key={`${point.key}-label`} x={x} y="230" textAnchor="middle" className="trend-axis-label">{point.label}</text> : null; })}
              </svg>{hoveredPoint && <div className="trend-tooltip" style={{ left: `${hoveredLeft}%` }}><strong>{hoveredPoint.label}</strong><span>工单总量 <b>{hoveredPoint.total}</b></span><span>已完成量 <b>{hoveredPoint.completed}</b></span><span>完成率 <b>{hoveredPoint.total ? Math.round((hoveredPoint.completed / hoveredPoint.total) * 100) : 0}%</b></span></div>}</div>
            </>}
  </section>;
}

function Overview({ summary, shops, scenarios, filters, selectedScenarioCode, refreshVersion, loading, onMetric }) {
  const [scenarioSort, setScenarioSort] = useState('desc');
  const total = Number(summary.total || 0);
  const success = Number(summary.autoSuccess || 0);
  const notSuccessful = Number(summary.notSuccessful ?? Math.max(0, total - success));
  const automationRate = total ? Math.round((success / total) * 100) : 0;
  const refundTotal = Number((summary.byScenario || []).find((item) => item.scenarioCode === 'return-refund')?.total || 0);
  const ordinaryTotal = Math.max(0, total - refundTotal);
  const scenarioRows = useMemo(() => {
    const byCode = new Map((summary.byScenario || []).map((item) => [item.scenarioCode, item]));
    const definitions = (scenarios || [])
      .filter((item) => item.enabled !== false)
      .map((item, index) => ({ ...item, displayOrder: Number(item.displayOrder ?? 999), sourceOrder: index }))
      .sort((left, right) => left.displayOrder - right.displayOrder || left.sourceOrder - right.sourceOrder);
    const definitionsByCode = new Map(definitions.map((item) => [item.code, item]));
    const selectedCodes = selectedScenarioCode
      ? [selectedScenarioCode]
      : [
        ...definitions.map((item) => item.code),
        ...[...byCode.keys()].filter((code) => !definitionsByCode.has(code)),
      ];
    return selectedCodes.map((code) => ({
      scenarioCode: code,
      displayName: definitionsByCode.get(code)?.displayName || labelScenario(code),
      total: 0,
      autoSuccess: 0,
      notSuccessful: 0,
      ...(byCode.get(code) || {}),
    }));
  }, [scenarios, selectedScenarioCode, summary.byScenario]);
  const sortedScenarioRows = useMemo(() => [...scenarioRows].sort((left, right) => {
    const delta = Number(left.autoSuccess || 0) - Number(right.autoSuccess || 0);
    return scenarioSort === 'asc' ? delta : -delta;
  }), [scenarioRows, scenarioSort]);
  const enabledShops = shops.filter((shop) => shop.enabled !== false);

  return <div className="view-stack">
    <div className="view-heading"><div><span className="eyebrow">OVERVIEW</span><h1>运营总览</h1><p>{enabledShops.length} 家店铺实时工单与运行状态</p></div><div className="rate-summary"><CircleGauge size={22} /><div><strong>{automationRate}%</strong><span>自动化成功率</span></div></div></div>
    {loading ? <LoadingBlock /> : <>
      <section className="metrics-grid">{metricDefinitions.map(([label, key, Icon, tone]) => <button type="button" className={`metric-tile ${tone} ${key === 'total' ? 'total-metric' : ''}`} key={key} onClick={() => onMetric(key)}><div className="metric-icon"><Icon size={19} /></div><div className="metric-copy"><span>{label}</span><strong>{key === 'notSuccessful' ? notSuccessful : summary[key] ?? 0}</strong>{key === 'total' ? <small className="metric-total-breakdown"><span>普通工单：<b>{ordinaryTotal}</b></span><span>退货退款：<b>{refundTotal}</b></span></small> : null}</div><ChevronRight className="metric-drilldown-icon" size={15} /></button>)}</section>
      <WorkOrderTrend filters={filters} refreshVersion={refreshVersion} />
      <div className="dashboard-grid">
        <section className="section-block scenario-section"><div className="section-heading"><div><h2>业务场景分布</h2><span>{scenarioRows.length} 个业务场景</span></div><button type="button" className="scenario-sort-button" onClick={() => setScenarioSort((value) => value === 'desc' ? 'asc' : 'desc')} title={`切换为自动化成功数${scenarioSort === 'desc' ? '从低到高' : '从高到低'}排序`}><ArrowUpDown size={15} /><span>成功数 {scenarioSort === 'desc' ? '高到低' : '低到高'}</span></button></div>
          {sortedScenarioRows.length ? <div className="scenario-list">{sortedScenarioRows.map((row) => {
            const rowTotal = Number(row.total || 0);
            const rowSuccess = Number(row.autoSuccess || 0);
            const rowPending = Number(row.notSuccessful ?? Math.max(0, rowTotal - rowSuccess));
            return <div className="scenario-row" key={row.scenarioCode}>
              <div className="scenario-name"><strong>{row.displayName}</strong><span>{row.scenarioCode}</span></div>
              <div className="scenario-progress"><div className="scenario-bar"><span style={{ width: `${rowTotal ? Math.max(3, Math.round((rowSuccess / rowTotal) * 100)) : 0}%` }} /></div></div>
              <div className="scenario-stats viewer"><span className="text-success"><strong>{rowSuccess}</strong>自动化成功</span><span className="text-danger"><strong>{rowPending}</strong>未成功</span></div>
            </div>;
          })}</div> : <EmptyState title="当前范围暂无场景数据" />}
        </section>
        <section className="section-block automation-section"><div className="section-heading"><div><h2>自动化结果</h2><span>业务处理实时统计</span></div></div><div className="donut-layout"><div className="donut" style={{ '--rate': `${automationRate * 3.6}deg` }}><div><strong>{automationRate}%</strong><span>成功率</span></div></div><div className="legend-list"><span><span className="legend-dot green" />自动化成功<strong>{success}</strong></span><span><span className="legend-dot red" />未成功<strong>{notSuccessful}</strong></span></div></div></section>
      </div>
      <section className="section-block"><div className="section-heading"><div><h2>店铺运行健康度</h2><span>PDD、OMS、TMS 会话与 Worker 检查点</span></div><span className="section-count">{enabledShops.length} 家店铺</span></div><div className="shop-health-grid">{enabledShops.map((shop) => <ShopHealth key={shop.shopId} shop={shop} />)}</div></section>
    </>}
  </div>;
}

function WorkOrders({ filters, scenarios, initialMetric, refreshVersion, setError, onOpenDetail, manualOnly = false }) {
  const [query, setQuery] = useState({ q: '', overviewMetric: initialMetric || 'total', scenarioCode: '', page: 1, pageSize: 20 });
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 20 });
  const [loading, setLoading] = useState(true);
  const requestQuery = useMemo(() => ({ ...filters, ...query, scenarioCode: query.scenarioCode || filters.scenarioCode }), [filters, query]);
  const queryString = useMemo(() => toQuery(requestQuery), [requestQuery]);

  useEffect(() => setQuery((current) => ({ ...current, overviewMetric: initialMetric || current.overviewMetric, page: 1 })), [initialMetric]);
  useEffect(() => {
    let cancelled = false;
    const load = (silent = false) => {
      if (!silent) setLoading(true);
      publicApi(`/api/v1/work-orders?${queryString}`).then((response) => !cancelled && setResult(response)).catch((error) => !cancelled && setError(error)).finally(() => !cancelled && setLoading(false));
    };
    load();
    const timer = window.setInterval(() => load(true), pollIntervalMs);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [queryString, refreshVersion, setError]);

  const pageCount = Math.max(1, Math.ceil(Number(result.total || 0) / Number(result.pageSize || query.pageSize)));
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">{manualOnly ? 'MANUAL HANDOFF' : 'WORK ORDERS'}</span><h1>{manualOnly ? '转人工工单' : '工单中心'}</h1><p>{manualOnly ? '查看需要人工接手的工单、原因和卡住阶段' : '自动化成功与未成功工单明细'}</p></div></div>
    <section className="filter-band"><div className="search-field"><Search size={17} /><input value={query.q} onChange={(event) => setQuery((current) => ({ ...current, q: event.target.value, page: 1 }))} placeholder="订单号、工单类型或售后编号" /></div><div className="filter-divider" /><Filter size={16} /><select value={query.scenarioCode} onChange={(event) => setQuery((current) => ({ ...current, scenarioCode: event.target.value, page: 1 }))}><option value="">全部场景</option>{scenarios.map((item) => <option value={item.code} key={item.code}>{item.displayName || labelScenario(item.code)}</option>)}</select><select value={query.overviewMetric} onChange={(event) => setQuery((current) => ({ ...current, overviewMetric: event.target.value, page: 1 }))}>{workOrderMetrics.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></section>
    <section className="table-section"><div className="table-meta"><span>共 <strong>{result.total}</strong> 张明细</span><span>第 {result.page || query.page} 页</span></div>{loading ? <LoadingBlock /> : result.data?.length ? <div className="table-scroll"><table className="data-table work-order-table viewer-result-visible public-work-order-table"><thead><tr><th>更新时间</th><th>店铺 / 订单</th><th>业务场景</th><th>工单类型</th><th>当前阶段</th><th>处理结果</th><th aria-label="查看详情" /></tr></thead><tbody>{result.data.map((row) => { const manualHandoff = row.handlingClassification === 'manual' || Boolean(row.manualReviewReason); return <tr key={row.id} onDoubleClick={() => onOpenDetail(row.id)}><td><time>{formatDateTime(row.updatedAt)}</time></td><td><strong className="order-number">{row.orderNumber || '-'}</strong><span className="subtext">{labelShop(row)}</span></td><td><strong>{labelScenario(row.scenarioCode)}</strong>{row.aftersaleCount ? <span className="subtext">{row.aftersaleCount} 个售后编号</span> : null}</td><td>{row.workOrderType || '-'}</td><td><code className="stage-code">{labelStage(row.currentStep)}</code>{row.manualReviewReason ? <span className="subtext public-manual-reason" title={row.manualReviewReason}>{row.manualReviewReason}</span> : null}</td><td><StatusBadge status={manualHandoff ? 'manual-review' : row.runtimeStatus} label={manualHandoff ? '转人工' : undefined} /></td><td><button className="row-open" onClick={() => onOpenDetail(row.id)} aria-label={`查看 ${row.orderNumber || '工单'} 详情`}><ChevronRight size={17} /></button></td></tr>; })}</tbody></table></div> : <EmptyState title={manualOnly ? '当前筛选范围暂无转人工工单' : '当前筛选范围暂无工单'} />}
      <div className="pagination"><button className="icon-button" aria-label="上一页" disabled={query.page <= 1} onClick={() => setQuery((current) => ({ ...current, page: current.page - 1 }))}><ChevronLeft size={18} /></button><span>{result.page || query.page} / {pageCount}</span><button className="icon-button" aria-label="下一页" disabled={query.page >= pageCount} onClick={() => setQuery((current) => ({ ...current, page: current.page + 1 }))}><ChevronRight size={18} /></button></div>
    </section>
  </div>;
}

function Shops({ shops, runtimeCapacity }) {
  const enabled = shops.filter((shop) => shop.enabled !== false);
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">SHOPS</span><h1>店铺状态</h1><p>店铺会话、Worker 与扫描调度</p></div><span className="section-count">{enabled.length} 家启用店铺</span></div>
    {runtimeCapacity && <section className="scheduler-capacity-band public-capacity-band"><div><span>启用店铺</span><strong>{runtimeCapacity.enabledShops ?? enabled.length}</strong><small>{runtimeCapacity.hotShops || 0} 热 / {runtimeCapacity.coldShops || 0} 冷</small></div><div><span>活跃浏览器</span><strong>{runtimeCapacity.slots?.active || 0}</strong><small>目标 {runtimeCapacity.slots?.target || 0}</small></div><div><span>到期队列</span><strong>{runtimeCapacity.dueShops || 0}</strong><small>{runtimeCapacity.overdueShops || 0} 家扫描逾期</small></div></section>}
    <section className="section-block"><div className="shop-health-grid">{enabled.map((shop) => <ShopHealth key={shop.shopId} shop={shop} />)}</div></section>
  </div>;
}

export default function PublicApp() {
  const [activeView, setActiveView] = useState('dashboard');
  const [filters, setFilters] = useState(() => {
    const currentDate = beijingToday();
    return { from: currentDate, to: currentDate, shopId: '', scenarioCode: '' };
  });
  const [summary, setSummary] = useState({ total: 0, autoSuccess: 0, notSuccessful: 0, byScenario: [] });
  const [shops, setShops] = useState([]);
  const [scenarios, setScenarios] = useState([]);
  const [runtime, setRuntime] = useState({ stage: 'PROD', platform: 'Windows', version: 'development' });
  const [runtimeCapacity, setRuntimeCapacity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [workOrderMetric, setWorkOrderMetric] = useState('total');
  const [detailId, setDetailId] = useState(null);
  const filterQuery = useMemo(() => toQuery(filters), [filters]);
  const refresh = useCallback(() => setRefreshVersion((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      publicApi(`/api/v1/metrics/summary?${filterQuery}`), publicApi('/api/v1/shops'),
      publicApi('/api/v1/scenarios'), publicApi('/api/v1/runtime'), publicApi('/api/v1/runtime/capacity'),
    ]).then(([summaryResult, shopsResult, scenariosResult, runtimeResult, capacityResult]) => {
      if (cancelled) return;
      setSummary(summaryResult.data || {});
      setShops(shopsResult.data || []);
      setScenarios(scenariosResult.data || []);
      setRuntime(runtimeResult.data || runtime);
      setRuntimeCapacity(capacityResult.data || null);
      setLastUpdatedAt(new Date());
      setError(null);
    }).catch((requestError) => !cancelled && setError(requestError)).finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [filterQuery, refreshVersion]);

  useEffect(() => {
    const timer = window.setInterval(refresh, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const openMetric = (metric) => {
    setWorkOrderMetric(metric);
    setActiveView(metric === 'manualReview' ? 'manual-review' : metric === 'verification' ? 'verification' : 'work-orders');
  };
  const openDetail = (id) => setDetailId(id);
  const currentView = {
    dashboard: <Overview summary={summary} shops={shops} scenarios={scenarios} filters={filters} selectedScenarioCode={filters.scenarioCode} refreshVersion={refreshVersion} loading={loading} onMetric={openMetric} />,
    'work-orders': <WorkOrders filters={filters} scenarios={scenarios} initialMetric={workOrderMetric} refreshVersion={refreshVersion} setError={setError} onOpenDetail={openDetail} />,
    'manual-review': <WorkOrders filters={filters} scenarios={scenarios} initialMetric="manualReview" refreshVersion={refreshVersion} setError={setError} onOpenDetail={openDetail} manualOnly />,
    verification: <PublicVerificationView filters={filters} refreshVersion={refreshVersion} setError={setError} onOpenWorkOrder={openDetail} />,
    shops: <Shops shops={shops} runtimeCapacity={runtimeCapacity} />,
  }[activeView];

  return <div className="app-shell public-viewer"><aside className="sidebar"><div className="brand"><img src={`${publicAssetBase}mascot.png`} alt="拼多多" /><div><strong>拼多多</strong><span>工单智能体</span></div></div><nav>{navigation.map((item) => <button key={item.id} className={activeView === item.id ? 'active' : ''} onClick={() => setActiveView(item.id)}><item.icon size={18} /><span>{item.label}</span></button>)}</nav><div className="sidebar-foot"><div className="environment"><span className="environment-mark">{runtime.stage}</span><div><strong>{runtime.platform}</strong><small>实时运营数据</small></div></div></div></aside>
    <div className="workspace"><header className="topbar"><div className="topbar-context"><Store size={18} /><select aria-label="店铺范围" value={filters.shopId} onChange={(event) => setFilters((current) => ({ ...current, shopId: event.target.value }))}><option value="">全部店铺</option>{shops.map((shop) => <option value={shop.shopId} key={shop.shopId}>{shop.name || shop.shopId}</option>)}</select></div><div className="topbar-context"><Layers3 size={18} /><select aria-label="业务场景" value={filters.scenarioCode} onChange={(event) => setFilters((current) => ({ ...current, scenarioCode: event.target.value }))}><option value="">全部业务场景</option>{scenarios.map((scenario) => <option value={scenario.code} key={scenario.code}>{scenario.displayName || labelScenario(scenario.code)}</option>)}</select></div><div className="date-range"><CalendarDays size={17} /><input aria-label="开始日期" type="date" value={filters.from} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} /><span>至</span><input aria-label="结束日期" type="date" value={filters.to} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} /></div><div className="topbar-actions"><IconButton label="刷新数据" onClick={refresh}><RefreshCw size={17} /></IconButton></div></header>
      <div className="mobile-nav">{navigation.map((item) => <button key={item.id} className={activeView === item.id ? 'active' : ''} onClick={() => setActiveView(item.id)} title={item.label}><item.icon size={18} /><span>{item.label}</span></button>)}</div><main className="content"><ErrorBanner error={error} onClose={() => setError(null)} />{currentView}</main><footer className="statusbar"><span><Activity size={14} />PostgreSQL 实时数据</span><span><Bot size={14} />{shops.length} 店铺动态 Worker</span><span>版本 {runtime.version}</span><span>最近刷新 {lastUpdatedAt ? lastUpdatedAt.toLocaleTimeString('zh-CN', { hour12: false }) : '-'}</span></footer></div>
    {detailId ? <PublicWorkOrderDrawer id={detailId} onClose={() => setDetailId(null)} /> : null}
  </div>;
}
