import React, { useEffect, useMemo, useState } from 'react';
import { BellRing, Bot, Check, CircleAlert, UserRoundCheck } from 'lucide-react';
import { api, ownerRequest, toQuery } from '../../services/api.js';
import { EmptyState, LoadingBlock, StatusBadge } from '../../components/Common.jsx';
import { formatDateTime, labelScenario, labelShop } from '../../app/format.js';
import DailySummaryPanel from '../dashboard/DailySummaryPanel.jsx';

export default function InterventionsView({
  filters, owner, isOwner, refreshVersion, refresh, setError, settings, updateDingTalkAutomatic,
}) {
  const [channel, setChannel] = useState('dashboard');
  const [status, setStatus] = useState('');
  const [result, setResult] = useState({ data: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const queryString = useMemo(() => toQuery({
    shopId: filters.shopId,
    scenarioCode: filters.scenarioCode,
    from: filters.from,
    to: filters.to,
    channel,
    status,
  }), [filters, channel, status]);
  useEffect(() => {
    let cancelled = false;
    const load = () => api(`/api/v1/manual-interventions?${queryString}`)
      .then((response) => !cancelled && setResult(response))
      .catch((error) => !cancelled && setError(error))
      .finally(() => !cancelled && setLoading(false));
    load();
    const timer = window.setInterval(load, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [queryString, refreshVersion, setError]);
  const updateStatus = async (id, nextStatus) => {
    try { await ownerRequest(`/api/v1/manual-interventions/${id}`, owner.csrfToken, { method: 'PATCH', body: JSON.stringify({ status: nextStatus }) }); refresh(); }
    catch (error) { setError(error); }
  };
  return <div className="view-stack"><div className="view-heading"><div><span className="eyebrow">HUMAN IN THE LOOP</span><h1>转人工中心</h1><p>前端人工事项与钉钉机器人通知分开追踪</p></div></div>
    {isOwner && <DailySummaryPanel owner={owner} refreshVersion={refreshVersion} setError={setError} />}
    <div className="segmented"><button className={channel === 'dashboard' ? 'active' : ''} onClick={() => setChannel('dashboard')}><UserRoundCheck size={17} />前端转人工</button><button className={channel === 'dingtalk' ? 'active' : ''} onClick={() => setChannel('dingtalk')}><Bot size={17} />机器人转人工</button></div>
    <section className="intervention-summary"><div className="intervention-icon">{channel === 'dashboard' ? <UserRoundCheck size={23} /> : <BellRing size={23} />}</div><div><strong>{channel === 'dashboard' ? '全部中断与人工关注事项' : '仓库超出范围与未知业务场景'}</strong><span>{channel === 'dashboard' ? '登录、验证、等待物流、页面异常和业务冲突均可追溯' : '自动推送只覆盖两类明确规则，其他工单由所有者手动推送'}</span></div><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option><option value="open">待处理</option><option value="acknowledged">已确认</option><option value="resolved">已解决</option><option value="cancelled">已取消</option></select></section>
    {channel === 'dingtalk' && <section className="dingtalk-control"><div><Bot size={19} /><span><strong>钉钉自动推送</strong><small>仓库不在选定范围或业务场景无法识别时自动发送</small></span></div><label className="toggle-control"><input type="checkbox" checked={settings?.dingtalkAutomaticEnabled === true} disabled={!isOwner} onChange={(event) => updateDingTalkAutomatic(event.target.checked)} /><span aria-hidden="true" /><b>{settings?.dingtalkAutomaticEnabled ? '已开启' : '已关闭'}</b></label></section>}
    <section className="table-section"><div className="table-meta"><span>共 <strong>{result.total}</strong> 项</span></div>{loading ? <LoadingBlock /> : result.data.length ? <div className="intervention-list">{result.data.map((item) => <article className="intervention-row" key={item.id}><div className={`risk-mark ${item.riskLevel}`}><CircleAlert size={19} /></div><div className="intervention-main"><div><strong>{item.workOrderType || item.reasonCode}</strong><StatusBadge status={item.status} /></div><p>{item.reason}</p><span>{labelShop(item.shopName || item.shopId)} · <b>{item.orderNumber || '店铺级事件'}</b>{item.aftersaleNumber ? ` · 售后 ${item.aftersaleNumber}` : ''}{item.platformCaseId ? ` · 平台工单 ${item.platformCaseId}` : ''} · {formatDateTime(item.createdAt)}</span><small>{labelScenario(item.scenarioCode)} · 风险 {item.riskLevel || '-'} · 通知 {item.notificationStatus || '未启用'} · 人工状态 {item.status} · 关闭 {formatDateTime(item.closedAt || item.resolvedAt)}</small></div><div className="intervention-channel"><span className={`channel-pill ${item.channel}`}>{item.channel === 'dingtalk' ? <Bot size={14} /> : <UserRoundCheck size={14} />}{item.channel === 'dingtalk' ? '钉钉机器人' : '前端看板'}</span>{item.channel === 'dingtalk' && <small>{item.deliverySource === 'owner-manual' ? '所有者手动' : '规则自动'} · 通知 {item.notificationStatus || '待入队'} · {item.notificationAttempts || 0} 次</small>}</div>{isOwner && item.status === 'open' && <div className="intervention-actions"><button className="button" onClick={() => updateStatus(item.id, 'acknowledged')}>确认接手</button><button className="button primary" onClick={() => updateStatus(item.id, 'resolved')}><Check size={15} />标记解决</button></div>}{isOwner && item.status === 'acknowledged' && <button className="button primary" onClick={() => updateStatus(item.id, 'resolved')}><Check size={15} />标记解决</button>}</article>)}</div> : <EmptyState title={channel === 'dingtalk' ? '当前没有机器人转人工记录' : '当前没有前端转人工事项'} />}</section>
  </div>;
}
