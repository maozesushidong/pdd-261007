import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ChevronLeft, ChevronRight, Download, Filter, Search, Send, Trash2, UserRound,
} from 'lucide-react';
import { api, ownerRequest, toQuery } from '../../services/api.js';
import { EmptyState, ErrorBanner, LoadingBlock, Modal, StatusBadge } from '../../components/Common.jsx';
import DingTalkMessageDialog from '../../components/DingTalkMessageDialog.jsx';
import WorkOrderDrawer from '../../components/WorkOrderDrawer.jsx';
import { formatDateTime, formatReturnRefundDirection, labelScenario, labelShop, labelStage } from '../../app/format.js';

const workOrderRequestTimeoutMs = 15_000;
const workOrderPollingIntervalMs = 15_000;
const ownerOverviewMetricOptions = [
  ['total', '总览：工单总量'],
  ['autoSuccess', '处理结构：业务里程碑完成'],
  ['humanConfirmed', '总览：其中人工协助'],
  ['processing', '总览：处理中'],
  ['waiting', '总览：等待中'],
  ['paused', '总览：已暂停'],
  ['failed', '总览：异常中断'],
  ['verification', '总览：等待验证'],
  ['strictAutoSuccess', '总览：严格自动化成功'],
  ['notStrictSuccessful', '处理结构：尚未严格完成'],
  ['notSuccessful', '处理结构：尚未达到业务里程碑'],
  ['refundAutoSuccess', '退货退款：自动退款'],
  ['refundManualCompleted', '退货退款：人工协助'],
  ['returnRefundWaiting', '退货退款：等待中工单'],
  ['raw', '全部原始工单记录'],
];
const viewerOverviewMetricOptions = [
  ['total', '工单总量'],
  ['autoSuccess', '自动化成功'],
  ['processing', '处理中'],
  ['waiting', '等待中'],
  ['paused', '已暂停'],
  ['failed', '异常中断'],
  ['verification', '等待验证'],
  ['notSuccessful', '未成功'],
];
const viewerOverviewMetricValues = new Set(viewerOverviewMetricOptions.map(([value]) => value));
const overviewMetricLabels = Object.fromEntries([
  ...ownerOverviewMetricOptions,
  ...viewerOverviewMetricOptions,
]);

const warehouseStateLabels = {
  pending: '待查询',
  confirmed: 'OMS 已确认',
  'read-failed': 'OMS 读取失败',
  ambiguous: '仓库不唯一',
  conflict: '仓库冲突',
  'not-applicable': '等待物流',
};

function WarehouseDisplay({ info, fallback }) {
  const status = info?.status || 'pending';
  const value = info?.omsValue || fallback || null;
  return <div className={`warehouse-display ${status}`}>
    <strong>{value || warehouseStateLabels[status]}</strong>
    <span>{value ? warehouseStateLabels[status] : info?.failureReason || warehouseStateLabels[status]}</span>
    {info?.tmsValue && <small className="mono">TMS：{info.tmsValue}</small>}
  </div>;
}

const refundItemsFor = (row) => (row.returnRefunds?.length
  ? row.returnRefunds
  : row.returnRefund ? [row.returnRefund] : []);

function ReturnRefundOrderSummary({ row }) {
  const refunds = refundItemsFor(row);
  return <>
    <span className="subtext">{labelShop(row)}</span>
    <span className="subtext refund-count">{refunds.length || row.aftersaleCount || 0} 个售后编号</span>
    {refunds.slice(0, 3).map((refund) => <small className="mono" key={refund.aftersaleNumber}>{refund.aftersaleNumber}</small>)}
    {refunds.length > 3 && <small>另有 {refunds.length - 3} 个</small>}
  </>;
}

function ReturnRefundLogistics({ row }) {
  const refunds = refundItemsFor(row);
  const active = refunds[0] || {};
  const amount = Number(active.refundAmount);
  return <div className="refund-logistics-cell">
    <strong>{Number.isFinite(amount) ? `¥${amount.toFixed(2)}` : '金额待读取'}</strong>
    <span>{active.returnCarrier || '暂无退货物流'}</span>
    <small className="mono">{active.returnTrackingNumber || formatDateTime(active.latestLogisticsAt)}</small>
  </div>;
}

function ReturnRefundRuleSummary({ row }) {
  const refunds = refundItemsFor(row);
  const directions = [...new Set(refunds.map(formatReturnRefundDirection))];
  return <div className="refund-dependency-cell">
    <strong>{directions.join('、') || '等待方向'}</strong>
    <span>PDD 退款规则判断</span>
  </div>;
}

const instanceIdentityLabels = {
  verified: '身份已确认',
  'legacy-unverified': '历史身份待确认',
};

function OrdinaryInstanceSummary({ row }) {
  const count = Number(row.ordinaryInstanceCount || 0);
  return <div className="ordinary-instance-summary">
    <span>{count > 0 ? `共 ${count} 次平台工单` : '平台工单身份待确认'}</span>
    {row.currentPlatformCaseId && <small className="mono">当前 #{row.currentPlatformCaseId}</small>}
    <small className={`ordinary-identity ${row.currentInstanceIdentityStatus === 'verified' ? 'verified' : 'unverified'}`}>
      {instanceIdentityLabels[row.currentInstanceIdentityStatus] || row.currentInstanceIdentityStatus || '身份待读取'}
    </small>
  </div>;
}

function BulkDialog({ rows, owner, onClose, onSaved }) {
  const [classification, setClassification] = useState('automated');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (event) => {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      await ownerRequest('/api/v1/work-orders/bulk-classification', owner.csrfToken, {
        method: 'POST', body: JSON.stringify({
          ids: rows.map((row) => row.id), classification, reason,
          expectedVersions: Object.fromEntries(rows.map((row) => [row.id, row.classificationVersion])),
        }),
      });
      onSaved(); onClose();
    } catch (requestError) { setError(requestError.message); } finally { setSaving(false); }
  };
  return <Modal title={`批量修改 ${rows.length} 张工单`} onClose={onClose}><form className="form-stack" onSubmit={submit}>{error && <div className="field-error">{error}</div>}<label><span>处理分类</span><select value={classification} onChange={(event) => setClassification(event.target.value)}><option value="automated">自动化</option><option value="manual">转人工</option></select></label><label><span>修改原因</span><textarea rows="3" required value={reason} onChange={(event) => setReason(event.target.value)} /></label><div className="modal-actions"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" disabled={saving || !reason.trim()}>{saving ? '提交中...' : '确认修改'}</button></div></form></Modal>;
}

const deleteBlockerLabels = {
  'active-processing': '工单正在处理，必须先切换或停止当前流程',
  'reserved-external-effect': '外部操作正在执行，当前不能删除',
  'unknown-external-effect': '外部操作结果未知，必须先完成只读核对',
  'delivered-operator-command': '人工命令已经下发，必须等待命令完成',
};

function DeleteWorkOrdersDialog({ rows, owner, onClose, onDeleted }) {
  const [reason, setReason] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (event) => {
    event.preventDefault();
    setDeleting(true);
    setError(null);
    try {
      const response = await ownerRequest('/api/v1/work-orders/bulk-delete', owner.csrfToken, {
        method: 'POST',
        body: JSON.stringify({ ids: rows.map((row) => row.id), reason }),
      });
      onDeleted(response.data?.workOrders?.map((row) => row.id) || rows.map((row) => row.id));
      onClose();
    } catch (requestError) {
      setError(requestError);
    } finally {
      setDeleting(false);
    }
  };
  const blockers = error?.payload?.blockers || [];
  return <Modal title={`删除 ${rows.length} 张工单`} onClose={onClose} width={560}>
    <div className="delete-shop-confirmation">
      <AlertTriangle size={22} />
      <div><strong>确认删除选中的工单？</strong><p>工单将从列表和统计中移除，并停止再次进入自动队列；所有者审计记录仍会保留。</p></div>
    </div>
    <div className="delete-work-order-list">
      {rows.slice(0, 8).map((row) => <span key={row.id}><strong>{row.orderNumber}</strong><small>{labelShop(row)}</small></span>)}
      {rows.length > 8 && <span><strong>另有 {rows.length - 8} 张工单</strong></span>}
    </div>
    {error && <div className="field-error"><strong>{blockers.length ? '以下工单暂时不能删除' : error.message}</strong>{blockers.map((blocker) => <span key={`${blocker.id}-${blocker.reason}`}>{blocker.orderNumber}：{deleteBlockerLabels[blocker.reason] || blocker.reason}</span>)}</div>}
    <form className="form-stack" onSubmit={submit}>
      <label><span>删除原因</span><textarea rows="3" required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <div className="modal-actions"><button type="button" className="button" onClick={onClose} disabled={deleting}>取消</button><button className="button danger" disabled={deleting || !reason.trim()}>{deleting ? '正在删除...' : '确认删除'}</button></div>
    </form>
  </Modal>;
}

export default function WorkOrdersView({ filters, shops, scenarios, owner, isOwner, refreshVersion, refresh, drilldown }) {
  const [query, setQuery] = useState({
    q: '',
    overviewMetric: drilldown?.metric || (isOwner ? 'total' : 'autoSuccess'),
    classification: '',
    scenarioCode: drilldown?.scenarioCode || '',
    page: 1,
    pageSize: 20,
  });
  const [result, setResult] = useState({ data: [], total: 0, page: 1, pageSize: 20 });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const initialDetail = new URLSearchParams(window.location.search).get('workOrderId');
  const [detailId, setDetailId] = useState(initialDetail || null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [dingtalkTarget, setDingtalkTarget] = useState(null);
  const requestRefreshRef = useRef(null);
  const handledRefreshVersionRef = useRef(refreshVersion);
  useEffect(() => {
    if (!drilldown) return;
    const requestedMetric = drilldown.metric || (isOwner ? 'total' : 'autoSuccess');
    setQuery((current) => ({
      ...current,
      q: '',
      overviewMetric: isOwner || viewerOverviewMetricValues.has(requestedMetric)
        ? requestedMetric
        : 'autoSuccess',
      classification: '',
      scenarioCode: drilldown.scenarioCode || '',
      page: 1,
    }));
    setSelected(new Set());
  }, [drilldown, isOwner]);
  useEffect(() => {
    if (isOwner) return;
    setQuery((current) => ({
      ...current,
      overviewMetric: viewerOverviewMetricValues.has(current.overviewMetric)
        ? current.overviewMetric
        : 'autoSuccess',
      classification: '',
      page: 1,
    }));
    setSelected(new Set());
  }, [isOwner]);
  const requestQuery = useMemo(() => ({
    ...filters,
    ...query,
    scenarioCode: query.scenarioCode || filters.scenarioCode,
  }), [filters, query]);
  const queryString = useMemo(() => toQuery(requestQuery), [requestQuery]);
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let refreshQueued = false;
    let activeController = null;
    const load = (silent = false) => {
      if (inFlight) {
        refreshQueued = true;
        return;
      }
      inFlight = true;
      if (!silent) setLoading(true);
      const controller = new AbortController();
      activeController = controller;
      const timeout = window.setTimeout(() => controller.abort(), workOrderRequestTimeoutMs);
      api(`/api/v1/work-orders?${queryString}`, { signal: controller.signal })
        .then((response) => {
          if (cancelled) return;
          setResult(response);
          setLoadError(null);
        })
        .catch((error) => {
          if (cancelled) return;
          setLoadError(controller.signal.aborted
            ? new Error('工单数据读取超过 15 秒，已停止本次请求并将在后台重试。')
            : error);
        })
        .finally(() => {
          window.clearTimeout(timeout);
          if (activeController === controller) activeController = null;
          inFlight = false;
          if (cancelled) return;
          if (!silent) setLoading(false);
          if (refreshQueued) {
            refreshQueued = false;
            load(true);
          }
        });
    };
    load();
    requestRefreshRef.current = () => load(true);
    const timer = window.setInterval(() => load(true), workOrderPollingIntervalMs);
    return () => {
      cancelled = true;
      activeController?.abort();
      requestRefreshRef.current = null;
      window.clearInterval(timer);
    };
  }, [queryString, isOwner]);
  useEffect(() => {
    if (handledRefreshVersionRef.current === refreshVersion) return;
    handledRefreshVersionRef.current = refreshVersion;
    requestRefreshRef.current?.();
  }, [refreshVersion]);
  const selectedRows = result.data.filter((row) => selected.has(row.id));
  const visibleOverviewMetricOptions = isOwner
    ? ownerOverviewMetricOptions
    : viewerOverviewMetricOptions;
  const openDetail = (id) => {
    setDetailId(id); const url = new URL(window.location.href); url.searchParams.set('workOrderId', id); history.replaceState({}, '', url);
  };
  const closeDetail = () => {
    setDetailId(null); const url = new URL(window.location.href); url.searchParams.delete('workOrderId'); history.replaceState({}, '', url);
  };
  const applyDeleted = (ids) => {
    const deletedIds = new Set(ids);
    setResult((current) => ({
      ...current,
      data: current.data.filter((row) => !deletedIds.has(row.id)),
      total: Math.max(0, current.total - deletedIds.size),
    }));
    setSelected(new Set());
    if (detailId && deletedIds.has(detailId)) closeDetail();
    refresh();
  };
  const toggleAll = (checked) => setSelected(checked ? new Set(result.data.map((row) => row.id)) : new Set());
  const pushToDingTalk = (event, row) => {
    event.stopPropagation();
    setDingtalkTarget(row);
  };
  const applyDingTalkSent = (notification) => {
    const targetId = dingtalkTarget?.id;
    setResult((current) => ({
      ...current,
      data: current.data.map((item) => item.id === targetId
        ? { ...item, dingtalkNotification: { ...notification, deliverySource: 'owner-manual' } }
        : item),
    }));
    refresh();
  };

  return <div className="view-stack">{loadError && <ErrorBanner error={loadError} onClose={() => setLoadError(null)} />}<div className="view-heading"><div><span className="eyebrow">WORK ORDERS</span><h1>工单中心</h1><p>{isOwner ? '完整业务结果、处理分类与证据追溯' : '自动化成功与未成功工单明细'}</p></div><div className="heading-actions">{isOwner && selectedRows.length > 0 && <><button className="button" onClick={() => setBulkOpen(true)}><UserRound size={16} />批量分类 ({selectedRows.length})</button><button className="button danger" onClick={() => setDeleteOpen(true)}><Trash2 size={16} />删除 ({selectedRows.length})</button></>}{isOwner && <a className="button primary" href={`/api/v1/exports/work-orders.csv?${queryString}`}><Download size={16} />导出 CSV</a>}</div></div>
    <section className="filter-band"><div className="search-field"><Search size={17} /><input value={query.q} onChange={(event) => setQuery((current) => ({ ...current, q: event.target.value, page: 1 }))} placeholder="订单号、平台工单编号、售后编号、工单类型或物流单号" /></div><div className="filter-divider" /><Filter size={16} /><select value={query.scenarioCode} onChange={(event) => setQuery((current) => ({ ...current, scenarioCode: event.target.value, page: 1 }))}><option value="">{filters.scenarioCode ? `跟随顶部：${labelScenario(filters.scenarioCode)}` : '全部场景'}</option>{scenarios.map((item) => <option value={item.code} key={item.code}>{item.displayName || labelScenario(item.code)}</option>)}</select><select value={query.overviewMetric} onChange={(event) => setQuery((current) => ({ ...current, overviewMetric: event.target.value, page: 1 }))}>{visibleOverviewMetricOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>{isOwner && <select value={query.classification} onChange={(event) => setQuery((current) => ({ ...current, classification: event.target.value, page: 1 }))}><option value="">全部处理分类</option><option value="automated">自动化</option><option value="manual">转人工</option></select>}</section>
    <section className="table-section">
      <div className="table-meta"><span><b>{overviewMetricLabels[query.overviewMetric] || '全部原始工单记录'}</b> · 共 <strong>{result.total}</strong> 张明细</span><span>第 {result.page} 页</span></div>
      {loading ? <LoadingBlock /> : result.data.length ? <div className="table-scroll">
        <table className={`data-table work-order-table${isOwner ? ' owner-analysis-visible' : ' viewer-result-visible'}`}>
          <thead><tr>
            {isOwner && <th className="checkbox-cell"><input type="checkbox" aria-label="选择本页" checked={result.data.length > 0 && selectedRows.length === result.data.length} onChange={(event) => toggleAll(event.target.checked)} /></th>}
            <th>更新时间</th><th>店铺 / 订单</th><th>业务场景 / 平台实例</th><th>退款 / 物流</th><th>规则结果 / 仓库</th>
            {isOwner ? <><th>运行状态</th><th>处理分类</th><th>当前阶段</th><th>未完成原因（中 / EN）</th><th>卡住位置</th></> : <th>自动化结果</th>}
            <th>{isOwner ? '人工操作' : ''}</th>
          </tr></thead>
          <tbody>{result.data.map((row) => <tr key={row.id} className={row.scenarioCode === 'return-refund' ? 'return-refund-row' : ''} onDoubleClick={() => openDetail(row.id)}>
            {isOwner && <td className="checkbox-cell"><input type="checkbox" aria-label={`选择 ${row.orderNumber}`} checked={selected.has(row.id)} onChange={(event) => setSelected((current) => { const next = new Set(current); event.target.checked ? next.add(row.id) : next.delete(row.id); return next; })} /></td>}
            <td><time>{formatDateTime(row.updatedAt)}</time></td>
            <td><strong className="order-number">{row.orderNumber}</strong>{row.scenarioCode === 'return-refund' ? <ReturnRefundOrderSummary row={row} /> : <span className="subtext">{labelShop(row)}</span>}</td>
            <td><strong>{labelScenario(row.scenarioCode)}</strong><span className="subtext">{row.scenarioCode === 'return-refund' ? `${row.aftersaleCount || refundItemsFor(row).length} 次售后` : row.workOrderType || '-'}</span>{row.scenarioCode !== 'return-refund' && <OrdinaryInstanceSummary row={row} />}</td>
            <td>{row.scenarioCode === 'return-refund' ? <ReturnRefundLogistics row={row} /> : <><strong>{row.carrier || '-'}</strong><span className="subtext mono">{row.trackingNumber || '暂无运单'}</span></>}</td>
            <td>{row.scenarioCode === 'return-refund' ? <ReturnRefundRuleSummary row={row} /> : <WarehouseDisplay info={row.warehouseInfo} fallback={row.warehouse} />}</td>
            {isOwner ? <>
              <td><StatusBadge status={row.runtimeStatus} /></td>
              <td><span className={`classification-pill ${row.handlingClassification}`}>{row.handlingClassification === 'manual' ? '转人工' : '自动化'}{row.classificationSource === 'admin-override' && <i>已修订</i>}</span></td>
              <td><code className="stage-code">{labelStage(row.currentStep)}</code></td>
              <td><span className="analysis-reason" title={row.incompleteAnalysis?.descriptionZh || row.incompleteAnalysis?.reasonZh}>{row.incompleteAnalysis?.reasonZh || row.incompleteAnalysis?.reason || '-'}</span>{row.incompleteAnalysis?.reasonEn && <span className="analysis-reason-en" title={row.incompleteAnalysis.descriptionEn}>{row.incompleteAnalysis.reasonEn}</span>}</td>
              <td><strong className="analysis-step">{row.incompleteAnalysis ? row.incompleteAnalysis.stoppedStepZh || labelStage(row.incompleteAnalysis.stoppedStep) : '-'}</strong>{row.incompleteAnalysis && <span className="subtext mono">{row.incompleteAnalysis.stoppedStepEn || row.incompleteAnalysis.stoppedStep}</span>}</td>
            </> : <>
              <td><span className={`automation-result-pill ${query.overviewMetric === 'autoSuccess' ? 'success' : 'unsuccessful'}`}>{query.overviewMetric === 'autoSuccess' ? '自动化成功' : '未成功'}</span></td>
            </>}
            <td><div className="row-actions" onDoubleClick={(event) => event.stopPropagation()}>{isOwner && <button className="button row-dingtalk-action" disabled={['pending', 'sending'].includes(row.dingtalkNotification?.status)} onClick={(event) => pushToDingTalk(event, row)}><Send size={15} />{['pending', 'sending'].includes(row.dingtalkNotification?.status) ? '发送中' : row.dingtalkNotification?.status === 'sent' ? '再次推送' : row.dingtalkNotification?.status === 'failed' ? '重新推送' : '推送钉钉'}</button>}<button className="row-open" onClick={() => openDetail(row.id)} aria-label="查看详情"><ChevronRight size={17} /></button></div></td>
          </tr>)}</tbody>
        </table>
      </div> : <EmptyState title="当前筛选范围暂无工单" />}
      <div className="pagination"><button className="icon-button" aria-label="上一页" disabled={query.page <= 1} onClick={() => setQuery((current) => ({ ...current, page: current.page - 1 }))}><ChevronLeft size={18} /></button><span>{result.page} / {Math.max(1, Math.ceil(result.total / result.pageSize))}</span><button className="icon-button" aria-label="下一页" disabled={result.page * result.pageSize >= result.total} onClick={() => setQuery((current) => ({ ...current, page: current.page + 1 }))}><ChevronRight size={18} /></button><select value={query.pageSize} onChange={(event) => setQuery((current) => ({ ...current, pageSize: Number(event.target.value), page: 1 }))}><option value="20">20 条/页</option><option value="50">50 条/页</option><option value="100">100 条/页</option></select></div>
    </section>
    {detailId && <WorkOrderDrawer id={detailId} owner={owner} isOwner={isOwner} scenarios={scenarios} onClose={closeDetail} onChanged={refresh} />}
    {bulkOpen && <BulkDialog rows={selectedRows} owner={owner} onClose={() => setBulkOpen(false)} onSaved={() => { setSelected(new Set()); refresh(); }} />}
    {deleteOpen && <DeleteWorkOrdersDialog rows={selectedRows} owner={owner} onClose={() => setDeleteOpen(false)} onDeleted={applyDeleted} />}
    {dingtalkTarget && <DingTalkMessageDialog workOrder={dingtalkTarget} owner={owner} onClose={() => setDingtalkTarget(null)} onSent={applyDingTalkSent} />}
  </div>;
}
