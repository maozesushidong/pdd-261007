import React, { useEffect, useState } from 'react';
import {
  Archive, CircleDollarSign, ClipboardCheck, History, Route, ScanLine,
  ShieldAlert, Store, Truck, X,
} from 'lucide-react';
import { EmptyState, IconButton, LoadingBlock, StatusBadge } from './Common.jsx';
import { formatDateTime, labelScenario, labelShop, labelStage } from '../app/format.js';
import { publicApi, publicResourceUrl } from '../services/public-api.js';

const shown = (value) => value != null && value !== '';
const shownDate = (value) => shown(value) ? formatDateTime(value) : null;

function DetailPairs({ rows, empty = '暂无记录' }) {
  const visible = rows.filter(([, value]) => shown(value));
  if (!visible.length) return <EmptyState title={empty} />;
  return <dl className="public-detail-pairs">{visible.map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{typeof value === 'boolean' ? (value ? '是' : '否') : value}</dd></React.Fragment>)}</dl>;
}

function VerificationSnapshot({ verification }) {
  if (!verification) return null;
  return <section className="public-detail-alert warning"><div><ScanLine size={19} /><span><strong>当前工单等待页面验证</strong><small>{labelStage(verification.stage)} · {String(verification.system || 'PDD').toUpperCase()} · {formatDateTime(verification.detectedAt)}</small></span></div>{verification.screenshotUrl ? <img src={publicResourceUrl(verification.screenshotUrl)} alt="验证码定位截图" /> : null}</section>;
}

export default function PublicWorkOrderDrawer({ id, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const manualHandoff = detail?.handlingClassification === 'manual'
    || Boolean(detail?.manualReviewReason)
    || Boolean(detail?.interventions?.length);
  const returnRefunds = Array.isArray(detail?.returnRefunds) ? detail.returnRefunds : [];
  const primaryReturnRefund = returnRefunds.find((refund) => (
    shown(refund.returnCarrier)
    || shown(refund.returnTrackingNumber)
    || shown(refund.latestLogisticsAt)
    || refund.logisticsTimeline?.length
  )) || returnRefunds[0] || null;
  const latestReturnTrace = primaryReturnRefund?.logisticsTimeline?.reduce((latest, item) => {
    if (!latest) return item;
    const latestAt = Date.parse(latest.occurredAt || latest.time || 0);
    const itemAt = Date.parse(item.occurredAt || item.time || 0);
    return Number.isFinite(itemAt) && (!Number.isFinite(latestAt) || itemAt > latestAt) ? item : latest;
  }, null) || null;
  const isReturnRefund = detail?.scenarioCode === 'return-refund';
  const logisticsRows = isReturnRefund ? [
    ['快递公司', primaryReturnRefund?.returnCarrier],
    ['物流单号', primaryReturnRefund?.returnTrackingNumber],
    ['最新轨迹', latestReturnTrace?.text || latestReturnTrace?.trace || latestReturnTrace?.description],
    ['轨迹时间', shownDate(latestReturnTrace?.occurredAt || primaryReturnRefund?.latestLogisticsAt)],
    ['首条轨迹时间', shownDate(primaryReturnRefund?.earliestLogisticsAt)],
    ['物流跨度', shown(primaryReturnRefund?.logisticsTransitSpanHours)
      ? `${Number(primaryReturnRefund.logisticsTransitSpanHours).toFixed(1)} 小时` : null],
  ] : [
    ['快递公司', detail?.logistics?.carrier || detail?.carrier],
    ['物流单号', detail?.logistics?.trackingNumber || detail?.trackingNumber],
    ['物流阶段', detail?.logistics?.stageLabel || detail?.logistics?.stageCode],
    ['当前城市', detail?.logistics?.currentCity],
    ['最新轨迹', detail?.logistics?.latestTrace],
    ['轨迹时间', shownDate(detail?.logistics?.latestTraceAt)],
  ];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    publicApi(`/api/v1/work-orders/${encodeURIComponent(id)}`)
      .then((response) => { if (!cancelled) { setDetail(response.data || null); setError(null); } })
      .catch((requestError) => { if (!cancelled) setError(requestError); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  return <div className="drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="drawer public-work-order-drawer" role="dialog" aria-modal="true" aria-label="工单详情">
      <header className="drawer-header"><div><span className="eyebrow">WORK ORDER</span><h2>{detail?.orderNumber || '工单详情'}</h2><p>{detail?.workOrderType || '正在读取工单信息'}</p></div><IconButton label="关闭详情" onClick={onClose}><X size={20} /></IconButton></header>
      {loading ? <LoadingBlock label="工单详情加载中" /> : error ? <div className="public-detail-error"><ShieldAlert size={20} /><span>{error.message || String(error)}</span></div> : detail ? <>
        <div className="drawer-summary"><div><span>店铺</span><strong>{labelShop(detail)}</strong></div><div><span>业务场景</span><strong>{labelScenario(detail.scenarioCode)}</strong></div><div><span>运行状态</span><StatusBadge status={detail.runtimeStatus} /></div><div><span>处理分类</span><StatusBadge status={manualHandoff ? 'manual-review' : 'completed'} label={manualHandoff ? '转人工' : '自动化'} /></div></div>
        <VerificationSnapshot verification={detail.verification} />
        <div className="drawer-content public-detail-content">
          {manualHandoff && <section className="detail-section full public-manual-detail"><h3><ShieldAlert size={18} />转人工信息</h3><DetailPairs rows={[["转人工原因", detail.manualReviewReason], ["当前阶段", labelStage(detail.currentStep)], ["更新时间", formatDateTime(detail.updatedAt)]]} />{detail.interventions?.map((item, index) => <div className="public-intervention-entry" key={`${item.createdAt || ''}-${index}`}><StatusBadge status={item.status || 'manual-review'} /><div><strong>{item.reason || item.reasonCode || '等待人工处理'}</strong><span>{formatDateTime(item.createdAt)}{item.resolvedAt ? ` · 完成于 ${formatDateTime(item.resolvedAt)}` : ''}</span></div></div>)}</section>}

          <div className="detail-grid">
            <section className="detail-section"><h3><ClipboardCheck size={18} />处理概览</h3><DetailPairs rows={[["订单号", detail.orderNumber], ["工单类型", detail.workOrderType], ["当前阶段", labelStage(detail.currentStep)], ["完成状态", detail.completionInfo?.state || detail.completionState], ["确认方式", detail.completionInfo?.confirmationMethod], ["确认时间", formatDateTime(detail.completionInfo?.confirmedAt || detail.completionConfirmedAt)], ["最近更新", formatDateTime(detail.updatedAt)]]} /></section>
            <section className="detail-section"><h3><Truck size={18} />{isReturnRefund ? '退货物流信息' : '物流信息'}</h3><DetailPairs rows={logisticsRows} empty={isReturnRefund ? '当前售后没有退货物流信息' : '暂无物流信息'} /></section>
            <section className="detail-section"><h3><Store size={18} />OMS 信息</h3><DetailPairs rows={[["订单状态", detail.oms?.orderStatus], ["发货仓库", detail.oms?.shippingWarehouse || detail.warehouse], ["仓库读取状态", detail.oms?.warehouseStatus], ["订单标记", detail.oms?.markText], ["低值品", detail.oms?.isLowValue], ["补发单", detail.oms?.isReissueOrder]]} empty="当前工单没有 OMS 记录" /></section>
            <section className="detail-section"><h3><Archive size={18} />TMS 信息</h3>{detail.tms?.length ? <div className="public-record-list">{detail.tms.map((item, index) => <DetailPairs key={`${item.ticketId || item.ticketNo || ''}-${index}`} rows={[["TMS 工单号", item.ticketNo || item.ticketId], ["问题类型", item.problemType], ["处理状态", item.status], ["客服备注", item.customerRemark], ["创建时间", formatDateTime(item.createdAt)], ["完成时间", formatDateTime(item.completedAt)]]} />)}</div> : <EmptyState title="当前工单没有 TMS 记录" />}</section>
          </div>

          {returnRefunds.length ? <section className="detail-section full"><h3><CircleDollarSign size={18} />退货退款明细</h3><div className="public-refund-list">{returnRefunds.map((refund, index) => <article key={`${refund.aftersaleNumber || ''}-${index}`}><header><div><strong>{refund.aftersaleNumber || '售后编号待读取'}</strong><span>{refund.aftersaleType || '退货退款'} · {refund.aftersaleStatus || refund.actionState || '-'}</span></div><StatusBadge status={['auto-refunded', 'manual-completed'].includes(refund.actionState) ? 'completed' : refund.actionState === 'manual-review' ? 'manual-review' : 'waiting'} /></header><DetailPairs rows={[["退款金额", shown(refund.refundAmount) ? `¥${Number(refund.refundAmount).toFixed(2)}` : null], ["退货快递", refund.returnCarrier], ["退货单号", refund.returnTrackingNumber], ["规则结果", refund.decision], ["当前状态", refund.actionState], ["下次检查", shownDate(refund.nextCheckAt)], ["完成时间", shownDate(refund.completedAt)]]} /></article>)}</div></section> : null}

          {detail.ordinaryInstances?.length ? <section className="detail-section full"><h3><Route size={18} />平台工单记录</h3><div className="public-instance-list">{detail.ordinaryInstances.map((instance, index) => <article className={instance.isCurrent ? 'current' : ''} key={`${instance.platformCaseId || ''}-${index}`}><div><strong>{instance.workOrderType || detail.workOrderType || '普通工单'}</strong><span>{instance.platformCaseId || '平台编号待读取'}</span></div><div><StatusBadge status={instance.status} /><small>{labelStage(instance.currentStep)}</small></div></article>)}</div></section> : null}

          <section className="detail-section full"><h3><History size={18} />流程时间线</h3>{detail.timeline?.length ? <div className="event-timeline public-timeline">{detail.timeline.map((event, index) => <div className={event.severity || 'info'} key={`${event.occurredAt || ''}-${index}`}><span className="event-node" /><time>{formatDateTime(event.occurredAt)}</time><div><strong>{labelStage(event.stage)}</strong><p>{event.message || event.reasonCode || event.eventType || '状态已更新'}</p></div></div>)}</div> : <EmptyState title="暂无流程时间线" />}</section>
        </div>
      </> : <EmptyState title="未找到工单详情" />}
    </aside>
  </div>;
}
