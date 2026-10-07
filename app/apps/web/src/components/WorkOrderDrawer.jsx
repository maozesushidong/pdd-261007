import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ChatAnalysisView from '../features/chat-analysis/ChatAnalysisView.jsx';
import {
  Archive, Bot, CheckCircle2, CircleDollarSign, ClipboardCheck, ExternalLink, FileImage, FilePenLine, History,
  Layers3, LockOpen, MapPin, PackageSearch, Play, RotateCcw, Route, Send, ShieldAlert, Trash2, Truck, UserRound, X,
} from 'lucide-react';
import { api, ownerRequest } from '../services/api.js';
import { EmptyState, ErrorBanner, IconButton, LoadingBlock, Modal, StatusBadge } from './Common.jsx';
import DingTalkMessageDialog from './DingTalkMessageDialog.jsx';
import { formatDateTime, formatReturnRefundDirection, humanizeKey, labelScenario, labelShop, labelStage } from '../app/format.js';

const returnRefundTabs = [
  ['summary', '处理概览'], ['refund', '售后明细'], ['logistics', '退货物流'],
  ['evidence', '证据'], ['timeline', '完整时间线'], ['audit', '修订记录'],
];
const deletableEvidenceKinds = new Set(['pdd-evidence', 'tms-evidence']);

const isScalar = (value) => value == null || ['string', 'number', 'boolean'].includes(typeof value);
const formatScalar = (value) => typeof value === 'boolean' ? value ? '是' : '否' : value == null || value === '' ? '-' : String(value);
const scalarEntries = (value, prefix = []) => Object.entries(value || {}).flatMap(([key, item]) => {
  const path = [...prefix, key];
  if (isScalar(item)) return [[path, item]];
  if (Array.isArray(item)) {
    if (!item.length) return [];
    if (item.every(isScalar)) return [[path, item.map(formatScalar).join('、')]];
    const preview = item.slice(0, 5).map((entry) => {
      if (!entry || typeof entry !== 'object') return formatScalar(entry);
      return Object.values(entry).filter(isScalar).filter((entryValue) => entryValue != null && entryValue !== '').map(formatScalar).join(' / ');
    }).filter(Boolean).join('；');
    return preview ? [[path, `${preview}${item.length > 5 ? `；共 ${item.length} 条` : ''}`]] : [];
  }
  return scalarEntries(item, path);
});

const businessLabel = (path) => path.map(humanizeKey).join(' / ');

function BusinessData({ value, empty }) {
  const entries = scalarEntries(value);
  if (!entries.length) return <EmptyState title={empty} />;
  return <div className="business-data">{entries.map(([path, item]) => <div key={path.join('.')}><span>{businessLabel(path)}</span><strong>{formatScalar(item)}</strong></div>)}</div>;
}

const identityStatusLabels = {
  verified: '平台身份已确认',
  'legacy-unverified': '历史工单身份待确认',
};

function OrdinaryInstancesPanel({ instances, scenarios }) {
  const scenariosByCode = new Map((scenarios || []).map((scenario) => [scenario.code, scenario]));
  if (!instances.length) return <section className="detail-section"><EmptyState title="当前订单尚无可确认的平台工单实例" /></section>;
  return <section className="detail-section ordinary-instances-section">
    <h3><Layers3 size={18} />同订单平台工单记录</h3>
    <p className="ordinary-instance-help">订单号只保留一条主记录；每个拼多多工单编号独立保存规则、证据、日志和外部系统结果。</p>
    <div className="ordinary-instance-list">{instances.map((instance) => {
      const definition = scenariosByCode.get(instance.scenarioCode);
      const omsApplicable = definition
        ? definition.requiresOms === true || definition.conditionalOms === true
        : (instance.omsAnalyses || []).length > 0;
      const tmsApplicable = definition
        ? definition.requiresTms === true || definition.conditionalTms === true
        : (instance.tmsWorkOrders || []).length > 0;
      const decisionData = {
        decision: instance.decision,
        manualReviewReason: instance.manualReviewReason,
        pddResolutionDecision: instance.payload?.pddResolutionDecision,
        pddResolutionFlow: instance.payload?.pddResolutionFlow,
        ruleResults: instance.payload?.ruleResults,
        interventions: instance.interventions,
      };
      return <article className={`ordinary-instance-card${instance.isCurrent ? ' current' : ''}`} key={instance.id}>
        <header><div><strong>{instance.platformCaseId ? `平台工单 #${instance.platformCaseId}` : '历史平台工单（身份待确认）'}</strong><span>{instance.workOrderType || labelScenario(instance.scenarioCode)} · {labelScenario(instance.scenarioCode)}</span></div><div className="ordinary-instance-badges">{instance.isCurrent && <span>当前实例</span>}<StatusBadge status={instance.runtimeStatus || instance.status} /></div></header>
        <div className="ordinary-instance-facts">
          <div><span>身份状态</span><strong>{identityStatusLabels[instance.identityStatus] || instance.identityStatus || '-'}</strong></div>
          <div><span>平台唯一身份</span><strong className="mono">{instance.platformCaseKey || '-'}</strong></div>
          <div><span>首次 / 最近发现</span><strong>{formatDateTime(instance.firstDiscoveredAt)}<small>{formatDateTime(instance.lastDiscoveredAt)}</small></strong></div>
          <div><span>开始 / 完成</span><strong>{formatDateTime(instance.startedAt)}<small>{formatDateTime(instance.completedAt)}</small></strong></div>
        </div>
        {instance.detailUrl && <a className="ordinary-instance-link" href={instance.detailUrl} target="_blank" rel="noopener" referrerPolicy="same-origin"><ExternalLink size={14} />打开该次拼多多工单详情</a>}
        <div className="ordinary-instance-detail-grid">
          <section><h4><ClipboardCheck size={15} />规则与处理判断</h4><BusinessData value={decisionData} empty="该实例暂无规则判断记录" /></section>
          <section><h4><Truck size={15} />PDD 与物流记录</h4><BusinessData value={{ logisticsAnalyses: instance.logisticsAnalyses, eventCount: instance.events?.length || 0, evidenceCount: instance.evidence?.length || 0 }} empty="该实例暂无物流记录" /></section>
          {omsApplicable && <section><h4><PackageSearch size={15} />OMS 记录</h4><BusinessData value={{ omsAnalyses: instance.omsAnalyses }} empty="该实例尚未产生 OMS 记录" /></section>}
          {tmsApplicable && <section><h4><Archive size={15} />TMS 记录</h4><BusinessData value={{ tmsWorkOrders: instance.tmsWorkOrders }} empty="该实例尚未产生 TMS 记录" /></section>}
        </div>
        <div className="ordinary-instance-history">
          <section><h4><FileImage size={15} />实例证据</h4>{instance.evidence?.length ? <div className="ordinary-instance-evidence">{instance.evidence.map((asset) => <a key={asset.id} href={`/api/v1/evidence/${asset.id}/content`} target="_blank" rel="noopener" referrerPolicy="same-origin"><FileImage size={14} /><span>{asset.kind}</span><small>{formatDateTime(asset.createdAt)}</small></a>)}</div> : <EmptyState title="该实例暂无证据文件" />}</section>
          <section><h4><History size={15} />实例运行日志</h4>{instance.events?.length ? <div className="ordinary-instance-events">{instance.events.map((event) => <div key={event.id}><time>{formatDateTime(event.occurredAt)}</time><strong>{labelStage(event.stage)}</strong><span>{event.message || event.reasonCode || event.eventType}</span></div>)}</div> : <EmptyState title="该实例暂无运行日志" />}</section>
        </div>
      </article>;
    })}</div>
  </section>;
}

function EditDialog({ mode, detail, onClose, onSaved, owner }) {
  const [reason, setReason] = useState('');
  const [classification, setClassification] = useState(detail.handling_classification || 'automated');
  const overrides = detail.payload?.manualOverrides || {};
  const [patch, setPatch] = useState({
    carrier: overrides.carrier || detail.logistics?.carrier || detail.payload?.logisticsAnalysis?.carrier || '',
    trackingNumber: overrides.trackingNumber || detail.logistics?.trackingNumber || detail.payload?.logisticsAnalysis?.trackingNumber || '',
    warehouse: overrides.warehouse || detail.oms?.shippingWarehouse || detail.oms?.matchedWarehouse || detail.oms?.warehouse || detail.oms?.warehouseName
      || detail.payload?.omsAnalysis?.shippingWarehouse || detail.payload?.omsAnalysis?.matchedWarehouse
      || detail.payload?.tmsAutofillVerification?.actual?.warehouse || detail.payload?.tmsRoutingDecision?.warehouse || '',
    workOrderType: overrides.workOrderType || detail.work_order_type || '',
    scenarioCode: overrides.scenarioCode || detail.scenario_code || '',
  });
  const [commandType, setCommandType] = useState(detail.recovery_state === 'held' ? 'skip-order' : 'retry-stage');
  const [reviewDecision, setReviewDecision] = useState('uncertain');
  const [observationMethod, setObservationMethod] = useState('pdd-detail-page');
  const [evidenceReference, setEvidenceReference] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const submit = async (event) => {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      if (!reason.trim()) throw new Error('必须填写修改原因');
      if (mode === 'classification') {
        await ownerRequest(`/api/v1/work-orders/${detail.id}/classification`, owner.csrfToken, {
          method: 'PATCH', body: JSON.stringify({ classification, reason, expectedVersion: detail.classification_version }),
        });
      } else if (mode === 'correction') {
        await ownerRequest(`/api/v1/work-orders/${detail.id}/corrections`, owner.csrfToken, {
          method: 'POST', body: JSON.stringify({ patch, reason, expectedVersion: detail.data_version }),
        });
      } else if (mode === 'external-review') {
        await ownerRequest(`/api/v1/work-orders/${detail.id}/external-state-review`, owner.csrfToken, {
          method: 'POST', body: JSON.stringify({
            decision: reviewDecision,
            observationMethod,
            reason,
            evidence: evidenceReference.trim() ? { reference: evidenceReference.trim() } : {},
            expectedRecoveryVersion: detail.recovery_version,
          }),
        });
      } else {
        await ownerRequest(`/api/v1/work-orders/${detail.id}/actions`, owner.csrfToken, {
          method: 'POST', body: JSON.stringify({ commandType, reason }),
        });
      }
      await onSaved(); onClose();
    } catch (requestError) { setError(requestError); } finally { setSaving(false); }
  };
  const title = mode === 'classification' ? '修改处理分类'
    : mode === 'correction' ? '修订工单数据'
      : mode === 'external-review' ? '核对平台状态' : '创建流程控制指令';
  return <Modal title={title} onClose={onClose} width={mode === 'correction' ? 680 : 500}><form className="form-stack" onSubmit={submit}><ErrorBanner error={error} />
    {mode === 'classification' && <label><span>处理分类</span><select value={classification} onChange={(event) => setClassification(event.target.value)}><option value="automated">自动化</option><option value="manual">转人工</option></select></label>}
    {mode === 'correction' && <div className="correction-grid">{Object.entries({ carrier: '快递公司', trackingNumber: '物流单号', warehouse: '发货仓库', workOrderType: '工单类型', scenarioCode: '场景代码' }).map(([key, label]) => <label key={key}><span>{label}</span><input value={patch[key]} onChange={(event) => setPatch((current) => ({ ...current, [key]: event.target.value }))} /></label>)}</div>}
    {mode === 'command' && <label><span>操作</span><select value={commandType} onChange={(event) => setCommandType(event.target.value)}><option value="retry-stage">重试当前阶段</option><option value="resume-auto">恢复自动处理</option><option value="refresh-next-order">刷新页面并处理下一单</option><option value="skip-order">跳过当前工单</option><option value="pause-shop">暂停店铺</option><option value="resume-shop">恢复店铺</option></select></label>}
    {mode === 'external-review' && <>
      <label><span>核对结果</span><select value={reviewDecision} onChange={(event) => setReviewDecision(event.target.value)}><option value="uncertain">仍不确定，继续冻结</option><option value="applied">平台已生效并完成</option><option value="not-applied">平台确认未生效，授权一次重试</option></select></label>
      <label><span>观察方式</span><select value={observationMethod} onChange={(event) => setObservationMethod(event.target.value)}><option value="pdd-detail-page">PDD 工单详情</option><option value="pdd-pending-list">PDD 待处理列表</option><option value="owner-remote-session">所有者远程窗口核对</option></select></label>
      <label><span>证据引用</span><input value={evidenceReference} onChange={(event) => setEvidenceReference(event.target.value)} placeholder="截图文件、页面时间或其他证据" /></label>
    </>}
    <label><span>原因</span><textarea rows="3" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="用于审计记录" /></label>
    <div className="modal-actions"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" disabled={saving}>{saving ? '提交中...' : '确认提交'}</button></div>
  </form></Modal>;
}

export default function WorkOrderDrawer({ id, owner, isOwner, scenarios = [], onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [activeTab, setActiveTab] = useState('summary');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editMode, setEditMode] = useState(null);
  const [dingtalkOpen, setDingtalkOpen] = useState(false);
  const [verificationCommand, setVerificationCommand] = useState(null);
  const [deletingEvidenceId, setDeletingEvidenceId] = useState(null);
  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try { setDetail((await api(`/api/v1/work-orders/${encodeURIComponent(id)}`)).data); setError(null); }
    catch (requestError) { setError(requestError); } finally { if (!silent) setLoading(false); }
  }, [id]);
  useEffect(() => {
    load();
    const timer = window.setInterval(() => load({ silent: true }), 5000);
    return () => window.clearInterval(timer);
  }, [load, isOwner]);
  const snapshot = detail?.payload || {};
  const logistics = detail?.logistics || snapshot.logisticsAnalysis || {};
  const oms = detail?.oms || snapshot.omsAnalysis || {};
  const decision = snapshot.pddResolutionDecision || snapshot.pddResolutionFlow || {};
  const events = detail?.events || [];
  const latestEventAt = detail?.latest_event_at || events.at(-1)?.occurred_at;
  const tmsItems = detail?.tms || (snapshot.tmsWorkOrder ? [{ payload: snapshot.tmsWorkOrder }] : []);
  const evidence = detail?.evidence || [];
  const overrides = detail?.payload?.manualOverrides || {};
  const displayType = overrides.workOrderType || detail?.work_order_type || snapshot.workOrderType || snapshot.targetWorkOrderTitle;
  const displayScenario = overrides.scenarioCode || detail?.scenario_code || snapshot.scenarioCode
    || snapshot.pddResolutionFlow?.code || snapshot.pddResolutionDecision?.scenarioCode || snapshot.tmsFormDecision?.scenarioCode;
  const isReturnRefund = displayScenario === 'return-refund';
  const ordinaryInstances = detail?.ordinaryInstances || [];
  const scenarioDefinition = scenarios.find((scenario) => scenario.code === displayScenario);
  const showOms = scenarioDefinition
    ? scenarioDefinition.requiresOms === true || scenarioDefinition.conditionalOms === true
    : true;
  const showTms = scenarioDefinition
    ? scenarioDefinition.requiresTms === true || scenarioDefinition.conditionalTms === true
    : true;
  const normalizedSingleRefund = detail?.returnRefund ? {
    workOrderId: detail.returnRefund.work_order_id,
    aftersaleNumber: detail.returnRefund.aftersale_number,
    refundAmount: detail.returnRefund.refund_amount,
    aftersaleType: detail.returnRefund.aftersale_type,
    aftersaleStatus: detail.returnRefund.aftersale_status,
    returnCarrier: detail.returnRefund.return_carrier,
    returnTrackingNumber: detail.returnRefund.return_tracking_number,
    earliestLogisticsAt: detail.returnRefund.earliest_logistics_at,
    latestLogisticsAt: detail.returnRefund.latest_logistics_at,
    logisticsTransitSpanHours: detail.returnRefund.logistics_transit_span_hours,
    logisticsContainsChangsha: detail.returnRefund.logistics_contains_changsha,
    logisticsContainsHengshuiJizhou: detail.returnRefund.logistics_contains_hengshui_jizhou,
    logisticsDirectionMatched: detail.returnRefund.logistics_direction_matched,
    logisticsTimeline: detail.returnRefund.logistics_timeline,
    ruleResults: detail.returnRefund.rule_results,
    decision: detail.returnRefund.decision,
    riskLevel: detail.returnRefund.risk_level,
    actionState: detail.returnRefund.action_state,
    nextCheckAt: detail.returnRefund.next_check_at,
    firstDiscoveredAt: detail.returnRefund.first_discovered_at,
    completedAt: detail.returnRefund.completed_at,
    completionMethod: detail.returnRefund.completion_method,
    evidence: detail.returnRefund.evidence,
  } : null;
  const returnRefunds = detail?.returnRefunds?.length
    ? detail.returnRefunds
    : normalizedSingleRefund ? [normalizedSingleRefund] : [];
  const tabs = isReturnRefund ? returnRefundTabs : [
    ['summary', '处理概览'], ['instances', `工单实例 (${ordinaryInstances.length})`], ['logistics', '物流轨迹'],
    ...(showOms ? [['oms', 'OMS']] : []), ...(showTms ? [['tms', 'TMS']] : []),
    ['evidence', '当前证据'], ['timeline', '当前时间线'], ['audit', '当前修订'],
    ...(isOwner ? [['chat-analysis', '聊天分析']] : []),
  ];
  const logisticsTimeline = isReturnRefund
    ? returnRefunds.flatMap((refund) => (refund.logisticsTimeline || []).map((item) => ({
      ...item,
      aftersaleNumber: refund.aftersaleNumber,
    })))
    : logistics.timeline || logistics.timelineRecords || logistics.traceRecords || [];
  const logisticsSummary = { ...logistics };
  delete logisticsSummary.timeline;
  delete logisticsSummary.timelineRecords;
  delete logisticsSummary.traceRecords;
  useEffect(() => {
    if (!tabs.some(([key]) => key === activeTab)) setActiveTab('summary');
  }, [activeTab, isReturnRefund, showOms, showTms, ordinaryInstances.length]);
  const dingtalkStatus = detail?.dingtalkNotification?.status;
  const dingtalkPending = ['pending', 'sending'].includes(dingtalkStatus);
  const verificationLocation = snapshot.verificationLocation || null;
  const waitingForVerification = detail?.current_step === 'human-verification-required'
    || detail?.runtime_status === 'verification';
  const applyDingTalkSent = (notification) => {
    setDetail((current) => ({
      ...current,
      dingtalkNotification: { ...notification, deliverySource: 'owner-manual' },
    }));
    onChanged?.();
  };
  const requestVerificationCommand = async (commandType) => {
    if (commandType === 'force-clear-verification'
      && !window.confirm('仅在页面已经没有验证码时使用。确认强制解除并继续当前工单？')) return;
    setVerificationCommand(commandType);
    try {
      await ownerRequest(`/api/v1/work-orders/${encodeURIComponent(id)}/actions`, owner.csrfToken, {
        method: 'POST',
        body: JSON.stringify({
          commandType,
          reason: commandType === 'force-clear-verification'
            ? '所有者从工单详情强制解除验证码等待并继续当前工单'
            : '所有者从工单详情请求立即复检验证码状态',
          payload: verificationLocation?.id ? { verificationId: verificationLocation.id } : {},
        }),
      });
      await load({ silent: true });
      onChanged?.();
    } catch (requestError) {
      setError(requestError);
    } finally {
      setVerificationCommand(null);
    }
  };
  const deleteEvidence = async (asset) => {
    if (!window.confirm('确认删除这张拼多多/TMS 截图？图片文件和数据库记录删除后无法恢复。')) return;
    setDeletingEvidenceId(asset.id);
    try {
      await ownerRequest(`/api/v1/evidence/${encodeURIComponent(asset.id)}`, owner.csrfToken, {
        method: 'DELETE',
        body: JSON.stringify({ reason: '系统所有者从工单证据页删除拼多多/TMS截图' }),
      });
      setDetail((current) => ({
        ...current,
        evidence: (current.evidence || []).filter((item) => item.id !== asset.id),
      }));
      onChanged?.();
    } catch (requestError) {
      setError(requestError);
    } finally {
      setDeletingEvidenceId(null);
    }
  };

  return <div className="drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="drawer" role="dialog" aria-modal="true" aria-label="工单详情">
    <header className="drawer-header"><div><span className="eyebrow">WORK ORDER</span><h2>{detail?.external_order_number || '工单详情'}</h2><p>{displayType || '-'}</p></div><IconButton label="关闭详情" onClick={onClose}><X size={20} /></IconButton></header>
    {loading ? <LoadingBlock label="正在读取完整处理记录" /> : error ? <ErrorBanner error={error} /> : detail && <>
      <div className="drawer-summary"><div><span>店铺</span><strong>{labelShop(detail)}</strong></div><div><span>场景</span><strong>{labelScenario(displayScenario)}</strong></div><div><span>运行状态</span><StatusBadge status={detail.runtime_status || detail.status} /></div><div><span>处理分类</span><StatusBadge status={detail.handling_classification === 'manual' ? 'manual-review' : 'completed'} label={detail.handling_classification === 'manual' ? '转人工' : '自动化'} /></div></div>
      <section className={`work-order-verification ${waitingForVerification ? 'is-waiting' : 'is-idle'}`}><div><ShieldAlert size={19} /><span><strong>{waitingForVerification ? '当前工单正在等待页面验证' : '验证处理入口'}</strong><small>{waitingForVerification ? (verificationLocation?.stage ? `阶段：${labelStage(verificationLocation.stage)}` : '可直接在本工单复检或解除等待') : `当前阶段：${labelStage(detail.current_step)}`}</small></span></div><div className="work-order-verification-actions">{detail.remoteDesktopPath && <a className="button primary" href={detail.remoteDesktopPath} target="_blank" rel="noopener" referrerPolicy="same-origin"><ExternalLink size={15} />打开远程窗口</a>}<button className="button" title={!isOwner ? '需要系统所有者登录' : !waitingForVerification ? '当前工单不在等待验证阶段' : '立即复检验证状态'} disabled={!isOwner || !waitingForVerification || Boolean(verificationCommand)} onClick={() => requestVerificationCommand('verification-recheck')}><RotateCcw size={15} />{verificationCommand === 'verification-recheck' ? '正在复检' : '立即复检'}</button><button className="button" title={!isOwner ? '需要系统所有者登录' : !waitingForVerification ? '当前工单不在等待验证阶段' : '强制解除验证等待并继续'} disabled={!isOwner || !waitingForVerification || Boolean(verificationCommand)} onClick={() => requestVerificationCommand('force-clear-verification')}><LockOpen size={15} />{verificationCommand === 'force-clear-verification' ? '正在解除' : '强制解除并继续'}</button></div></section>
      {isOwner && <div className="owner-actionbar"><button className="button" onClick={() => setEditMode('classification')}><UserRound size={16} />修改分类</button><button className="button" onClick={() => setEditMode('correction')}><FilePenLine size={16} />修订数据</button><button className="button" onClick={() => setEditMode('command')}><Play size={16} />流程控制</button>{!isReturnRefund && detail.recovery_state !== 'ready' && <button className="button" onClick={() => setEditMode('external-review')}><ShieldAlert size={16} />核对平台状态</button>}<button className="button dingtalk-action" disabled={dingtalkPending} onClick={() => setDingtalkOpen(true)}><Send size={16} />{dingtalkPending ? '钉钉待发送' : dingtalkStatus === 'sent' ? '再次推送钉钉' : dingtalkStatus === 'failed' ? '重新推送钉钉' : '推送钉钉'}</button><span><ShieldAlert size={15} />{isReturnRefund ? '退款流程只依赖 PDD，操作写入审计日志' : '所有操作写入审计日志'}</span></div>}
      {isOwner && detail.incompleteAnalysis && <section className="owner-incomplete-analysis"><h3><ShieldAlert size={18} />未完成流程分析</h3><div><span>中文描述</span><strong>{detail.incompleteAnalysis.descriptionZh || detail.incompleteAnalysis.reasonZh || detail.incompleteAnalysis.reason}</strong></div><div><span>English description</span><strong lang="en">{detail.incompleteAnalysis.descriptionEn || detail.incompleteAnalysis.reasonEn || '-'}</strong></div><div className="analysis-checkpoint"><span>程序卡点 / Stopped at</span><strong>{detail.incompleteAnalysis.stoppedStepZh || labelStage(detail.incompleteAnalysis.stoppedStep)} / {detail.incompleteAnalysis.stoppedStepEn || detail.incompleteAnalysis.stoppedStep}</strong><code>{detail.incompleteAnalysis.stoppedStep}</code>{detail.incompleteAnalysis.checkpoint !== detail.incompleteAnalysis.stoppedStep && <small>当前检查点：{labelStage(detail.incompleteAnalysis.checkpoint)}</small>}</div></section>}
      <nav className="drawer-tabs">{tabs.map(([key, label]) => <button className={activeTab === key ? 'active' : ''} onClick={() => setActiveTab(key)} key={key}>{label}{key === 'timeline' && events.length ? ` (${events.length})` : ''}</button>)}</nav>
      <div className="drawer-content">
        {activeTab === 'summary' && (isReturnRefund ? <div className="detail-grid"><section className="detail-section"><h3><CircleDollarSign size={18} />退款处理概览</h3><BusinessData value={{ orderNumber: detail.external_order_number, scenarioCode: displayScenario, aftersaleCount: returnRefunds.length, currentStep: labelStage(detail.current_step), runtimeStatus: detail.runtime_status, handlingClassification: detail.handling_classification, manualReviewReason: detail.manual_review_reason }} empty="暂无退货退款记录" /></section><section className="detail-section"><h3><ShieldAlert size={18} />处理范围</h3><div className="dependency-boundary"><div><CheckCircle2 size={17} /><span><strong>PDD</strong><small>扫描、读取、判断与退款执行</small></span></div><div><CheckCircle2 size={17} /><span><strong>数据库与现有看板</strong><small>售后编号、证据、日志与转人工</small></span></div></div></section><section className="detail-section full"><h3><History size={18} />当前检查点</h3><BusinessData value={{ step: labelStage(detail.current_step), completionState: detail.completionInfo?.state, confirmationMethod: detail.completionInfo?.confirmationMethod, confirmedAt: formatDateTime(detail.completionInfo?.confirmedAt), latestEventAt: formatDateTime(latestEventAt), nextCheckAt: formatDateTime(returnRefunds[0]?.nextCheckAt), manualReviewReason: detail.manual_review_reason }} /></section></div> : <div className="detail-grid"><section className="detail-section"><h3><ClipboardCheck size={18} />PDD 处理结果</h3><BusinessData value={{ orderNumber: detail.external_order_number, scenarioCode: displayScenario, workOrderType: displayType, currentStep: labelStage(detail.current_step), orderRemark: snapshot.pddOrderRemark, ...decision }} empty="暂无 PDD 处理结果" /></section><section className="detail-section"><h3><Route size={18} />关键决策</h3><BusinessData value={{ ...(snapshot.tmsRoutingDecision || {}), ...(snapshot.tmsFormDecision || {}), ...(snapshot.tmsAutofillVerification || {}) }} empty="暂无决策记录" /></section><section className="detail-section full"><h3><History size={18} />当前检查点</h3><BusinessData value={{ step: labelStage(detail.current_step), runtimeStatus: detail.runtime_status, completionState: detail.completionInfo?.state, confirmationMethod: detail.completionInfo?.confirmationMethod, confirmedAt: formatDateTime(detail.completionInfo?.confirmedAt), recoveryState: detail.recovery_state, recoveryReason: detail.recovery_reason, recoveryVersion: detail.recovery_version, recoveryUpdatedAt: formatDateTime(detail.recovery_updated_at), latestEventAt: formatDateTime(latestEventAt), lastSyncedAt: formatDateTime(detail.dataFreshness?.lastSyncedAt), syncLagSeconds: detail.dataFreshness?.syncLagSeconds, manualReviewReason: detail.manual_review_reason, classificationSource: detail.classification_source }} /></section></div>)}
        {activeTab === 'instances' && <OrdinaryInstancesPanel instances={ordinaryInstances} scenarios={scenarios} />}
        {isOwner && activeTab === 'chat-analysis' && <ChatAnalysisView owner={owner} isOwner={isOwner} shopId={detail.shop_id} orderNumber={detail.external_order_number} />}
        {activeTab === 'refund' && <section className="detail-section"><h3><CircleDollarSign size={18} />同订单售后记录</h3>{returnRefunds.length ? <div className="refund-record-list">{returnRefunds.map((refund) => {
          const direction = formatReturnRefundDirection(refund);
          const directionMatched = refund.logisticsContainsChangsha === true
            || refund.logisticsContainsHengshuiJizhou === true;
          const directionClass = directionMatched ? 'text-success'
            : refund.actionState === 'waiting-logistics' ? '' : 'text-danger';
          return <article key={refund.aftersaleNumber || refund.workOrderId}><header><div><strong>{refund.aftersaleNumber || '售后编号待读取'}</strong><span>{refund.aftersaleType || '退货退款'} · {refund.aftersaleStatus || refund.actionState || '-'}</span></div><StatusBadge status={refund.actionState === 'auto-refunded' || refund.actionState === 'manual-completed' ? 'completed' : refund.actionState === 'manual-review' ? 'manual-review' : 'waiting'} /></header><div className="refund-highlight-grid"><div><span>退款金额</span><strong>{Number.isFinite(Number(refund.refundAmount)) ? `¥${Number(refund.refundAmount).toFixed(2)}` : '-'}</strong></div><div><span>物流更新时间</span><strong>{formatDateTime(refund.latestLogisticsAt)}</strong></div><div><span>物流方向</span><strong className={directionClass}>{direction}</strong></div><div><span>转人工</span><strong>{refund.riskLevel ? `${refund.riskLevel} 风险` : '否'}</strong></div></div><div className="refund-record-details"><section><h4><MapPin size={15} />退货物流</h4><BusinessData value={{ returnCarrier: refund.returnCarrier, returnTrackingNumber: refund.returnTrackingNumber, firstDiscoveredAt: formatDateTime(refund.firstDiscoveredAt), earliestLogisticsAt: formatDateTime(refund.earliestLogisticsAt), latestLogisticsAt: formatDateTime(refund.latestLogisticsAt), logisticsTransitSpanHours: refund.logisticsTransitSpanHours, logisticsDirectionMatched: direction }} empty="买家尚未产生退货物流" /></section><section><h4><ClipboardCheck size={15} />规则与证据</h4><BusinessData value={{ decision: refund.decision, riskLevel: refund.riskLevel, actionState: refund.actionState, nextCheckAt: formatDateTime(refund.nextCheckAt), completedAt: formatDateTime(refund.completedAt), ruleResults: refund.ruleResults, evidence: refund.evidence }} empty="暂无规则判断" /></section></div></article>;
        })}</div> : <EmptyState title="当前订单没有售后编号记录" />}</section>}
        {activeTab === 'logistics' && <section className="detail-section"><h3><Truck size={18} />{isReturnRefund ? '退货物流' : '物流分析'}</h3>{!isReturnRefund && <BusinessData value={logisticsSummary} empty="当前工单没有物流信息" />}{logisticsTimeline.length > 0 ? <div className="trace-list">{logisticsTimeline.map((item, index) => <div key={`${item.aftersaleNumber || ''}-${item.occurredAt || item.time || index}`}><span /><time>{formatDateTime(item.time || item.timestamp || item.occurredAt)}</time><p>{item.aftersaleNumber && <b>{item.aftersaleNumber} · </b>}{item.text || item.trace || item.description || JSON.stringify(item)}</p></div>)}</div> : isReturnRefund && <EmptyState title="买家尚未产生退货物流，系统将在等待期后复查" />}</section>}
        {activeTab === 'oms' && <div className="detail-grid"><section className="detail-section"><h3><PackageSearch size={18} />OMS 仓库事实</h3><BusinessData value={{ status: detail.warehouseInfo?.status, omsWarehouse: detail.warehouseInfo?.omsValue, omsSource: detail.warehouseInfo?.omsSource, omsObservedAt: detail.warehouseInfo?.omsObservedAt, failureReason: detail.warehouseInfo?.failureReason, tmsWarehouse: detail.warehouseInfo?.tmsValue, comparison: detail.warehouseInfo?.comparison }} empty="暂无 OMS 仓库事实" /></section><section className="detail-section"><h3><PackageSearch size={18} />OMS 原始分析</h3><BusinessData value={oms} empty="暂无 OMS 查询结果" /></section></div>}
        {activeTab === 'tms' && <section className="detail-section"><h3><Archive size={18} />TMS 工单</h3>{tmsItems.length ? <div className="record-list">{tmsItems.map((item, index) => <div key={item.id || index}><BusinessData value={item.payload || item} /></div>)}</div> : <EmptyState title="当前工单没有 TMS 记录" />}</section>}
        {activeTab === 'evidence' && <section className="detail-section"><h3><FileImage size={18} />证据文件</h3>{evidence.length ? <div className="evidence-grid">{evidence.map((asset) => <article className="evidence-card" key={asset.id}><a href={`/api/v1/evidence/${asset.id}/content`} target="_blank" rel="noopener" referrerPolicy="same-origin"><div className="evidence-preview"><FileImage size={28} /></div><strong>{asset.kind}</strong><span>{asset.mime_type} · {asset.status}</span><small>{formatDateTime(asset.created_at)}</small><ExternalLink size={14} /></a>{isOwner && deletableEvidenceKinds.has(asset.kind) && <IconButton className="evidence-delete" label={`删除 ${asset.kind} 截图`} disabled={deletingEvidenceId === asset.id} onClick={() => deleteEvidence(asset)}><Trash2 size={15} /></IconButton>}</article>)}</div> : <EmptyState title="暂无已入库证据" />}</section>}
        {activeTab === 'timeline' && <section className="detail-section"><h3><History size={18} />全流程时间线</h3>{events.length ? <div className="event-timeline">{events.map((event) => <div className={event.severity || 'info'} key={event.id}><span className="event-node" /><time>{formatDateTime(event.occurred_at)}</time><div><strong>{String(event.system_name || 'pdd').toUpperCase()} · {labelStage(event.stage)}</strong><p>{event.message || event.reason_code || event.event_type}</p><small>{event.event_key}</small></div></div>)}</div> : <EmptyState title="暂无事件时间线" />}</section>}
        {activeTab === 'audit' && <div className="detail-grid"><section className="detail-section"><h3><UserRound size={18} />分类历史</h3>{detail.classificationHistory?.length ? <div className="audit-list">{detail.classificationHistory.map((item) => <div key={item.id}><span>{formatDateTime(item.created_at)}</span><strong>{item.previous_classification || '-'} → {item.next_classification}</strong><p>{item.reason}</p><small>{item.actor_id}</small></div>)}</div> : <EmptyState title="暂无分类修订" />}</section><section className="detail-section"><h3><FilePenLine size={18} />数据修订</h3>{detail.corrections?.length ? <div className="audit-list">{detail.corrections.map((item) => <div key={item.id}><span>{formatDateTime(item.created_at)}</span><strong>版本 {item.version}</strong><p>{item.reason}</p><small>{Object.keys(item.patch || {}).join('、')}</small></div>)}</div> : <EmptyState title="暂无数据修订" />}</section></div>}
      </div>
    </>}
  </aside>{editMode && detail && <EditDialog mode={editMode} detail={detail} owner={owner} onClose={() => setEditMode(null)} onSaved={async () => { await load(); onChanged?.(); }} />}{dingtalkOpen && detail && <DingTalkMessageDialog workOrder={detail} owner={owner} onClose={() => setDingtalkOpen(false)} onSent={applyDingTalkSent} />}</div>;
}
