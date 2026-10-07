import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CircleDot, Filter, Search, ShieldCheck, TerminalSquare, Workflow } from 'lucide-react';
import { api, toQuery } from '../../services/api.js';
import { EmptyState, LoadingBlock } from '../../components/Common.jsx';
import { formatDateTime, labelShop, labelStage } from '../../app/format.js';

const auditLabels = {
  'owner-login-succeeded': '所有者登录成功',
  'owner-login-failed': '所有者登录失败',
  'owner-logout': '所有者退出登录',
  'evidence-screenshot-deleted': 'PDD/TMS 证据截图已删除',
};

const auditPayload = (payload) => {
  const entries = Object.entries(payload || {}).filter(([, value]) => value != null && value !== '');
  return entries.length ? entries.map(([key, value]) => `${key}: ${String(value)}`).join(' | ') : '-';
};

export default function LogsView({ filters, isOwner, refreshVersion, setError }) {
  const [mode, setMode] = useState('workflow');
  const [query, setQuery] = useState({
    q: '', system: '', severity: '', reasonCode: '', page: 1, pageSize: 100, includeTotal: true,
  });
  const [result, setResult] = useState({ data: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const queryString = useMemo(() => toQuery({ ...filters, ...query }), [filters, query]);

  useEffect(() => {
    if (!isOwner && mode === 'audit') setMode('workflow');
  }, [isOwner, mode]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const endpoint = mode === 'audit' ? '/api/v1/audit-events' : '/api/v1/logs';
    api(`${endpoint}?${queryString}`)
      .then((response) => !cancelled && setResult(response))
      .catch((error) => !cancelled && setError(error))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [mode, queryString, refreshVersion, setError]);

  const reasonCodes = mode === 'workflow'
    ? [...new Set(result.data.map((item) => item.reasonCode).filter(Boolean))]
    : [];

  return <div className="view-stack">
    <div className="view-heading">
      <div><span className="eyebrow">OBSERVABILITY</span><h1>运行日志</h1><p>{mode === 'audit' ? '所有者登录与管理操作审计' : '全部店铺全流程结构化事件与中断原因'}</p></div>
      <div className="heading-actions">
        {isOwner && <div className="segmented">
          <button className={mode === 'workflow' ? 'active' : ''} onClick={() => setMode('workflow')}><Workflow size={16} />流程日志</button>
          <button className={mode === 'audit' ? 'active' : ''} onClick={() => setMode('audit')}><ShieldCheck size={16} />所有者审计</button>
        </div>}
        <div className="live-label"><span />LIVE STREAM</div>
      </div>
    </div>

    <section className="filter-band">
      <div className="search-field"><Search size={17} /><input value={query.q} onChange={(event) => setQuery((current) => ({ ...current, q: event.target.value, page: 1 }))} placeholder={mode === 'audit' ? '操作人、事件类型或操作内容' : '订单号、阶段或日志内容'} /></div>
      {mode === 'workflow' && <><div className="filter-divider" /><Filter size={16} /><select value={query.system} onChange={(event) => setQuery((current) => ({ ...current, system: event.target.value, page: 1 }))}><option value="">全部系统</option><option value="pdd">PDD</option><option value="oms">OMS</option><option value="tms">TMS</option></select><select value={query.severity} onChange={(event) => setQuery((current) => ({ ...current, severity: event.target.value, page: 1 }))}><option value="">全部级别</option><option value="info">INFO</option><option value="warning">WARNING</option><option value="error">ERROR</option></select><select value={query.reasonCode} onChange={(event) => setQuery((current) => ({ ...current, reasonCode: event.target.value, page: 1 }))}><option value="">全部原因</option>{reasonCodes.map((code) => <option value={code} key={code}>{code}</option>)}</select></>}
    </section>

    <section className="table-section log-table-section">
      <div className="table-meta"><span>当前{result.totalIsEstimate ? '约' : '共'} <strong>{result.total}</strong> 条{mode === 'audit' ? '审计记录' : '事件'}</span><span className="immutable-mark"><CircleDot size={13} />原始日志不可修改</span></div>
      {loading ? <LoadingBlock /> : mode === 'audit' ? (
        result.data.length ? <div className="table-scroll"><table className="data-table log-table"><thead><tr><th>发生时间</th><th>操作人</th><th>审计事件</th><th>店铺 / 订单</th><th>操作信息</th></tr></thead><tbody>{result.data.map((row) => <tr key={row.id}><td><time>{formatDateTime(row.createdAt)}</time></td><td><span className="system-pill pdd">{row.actorId || 'system'}</span></td><td><strong>{auditLabels[row.eventType] || row.eventType}</strong><span className="subtext mono">{row.eventType}</span></td><td><strong>{row.shopId ? labelShop(row.shopId) : '系统级'}</strong><span className="subtext mono">{row.orderNumber || '-'}</span></td><td><p className="log-message">{auditPayload(row.payload)}</p></td></tr>)}</tbody></table></div>
          : <EmptyState title="当前范围暂无审计日志" />
      ) : (
        result.data.length ? <div className="table-scroll"><table className="data-table log-table"><thead><tr><th>发生时间</th><th>级别</th><th>系统</th><th>店铺 / 订单</th><th>阶段</th><th>原因代码</th><th>日志内容</th></tr></thead><tbody>{result.data.map((row) => <tr key={row.id}><td><time>{formatDateTime(row.occurredAt)}</time></td><td><span className={`severity ${row.severity || 'info'}`}>{row.severity === 'error' ? <AlertTriangle size={13} /> : <TerminalSquare size={13} />}{String(row.severity || 'info').toUpperCase()}</span></td><td><span className={`system-pill ${row.system}`}>{String(row.system || 'pdd').toUpperCase()}</span></td><td><strong>{labelShop(row.shopId)}</strong><span className="subtext mono">{row.orderNumber || '店铺级事件'}</span></td><td><code className="stage-code">{labelStage(row.stage)}</code></td><td><span className="reason-code">{row.reasonCode || '-'}</span></td><td><p className="log-message">{row.message || row.eventType || '-'}</p><small className="event-key">{row.eventKey}</small></td></tr>)}</tbody></table></div>
          : <EmptyState title="当前范围暂无日志" />
      )}
    </section>
  </div>;
}
