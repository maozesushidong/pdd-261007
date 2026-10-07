import React, { useEffect, useState } from 'react';
import { RefreshCw, MessageSquareText, ChevronLeft } from 'lucide-react';
import { api, ownerRequest, toQuery } from '../../services/api.js';
import { EmptyState, ErrorBanner } from '../../components/Common.jsx';
import { formatDateTime } from '../../app/format.js';
import './chat-analysis.css';

const states = { collecting: '提取聊天记录', 'analysis-pending': '等待分析', running: '分析中',
  'awaiting-owner-approval': '分析完成，待核对', 'auto-ready': '已进入自动执行', 'owner-review': '所有者待核实', analyzed: '分析完成',
  pending: '等待分析', retry: '稍后重试', failed: '分析失败', confirmed: '反馈已完成' };
const errors = { CHAT_MODEL_NOT_CONFIGURED: '模型未配置', CHAT_MODEL_HTTP_401: '模型密钥无效',
  CHAT_MODEL_HTTP_403: '模型接口权限不足', CHAT_MODEL_NETWORK_OR_TIMEOUT: '模型请求超时或网络异常',
  CHAT_MODEL_INVALID_JSON: '模型输出格式无法解析', CHAT_MODEL_OUTPUT_INCOMPLETE: '模型输出不完整' };

export default function ChatAnalysisView({ owner, isOwner = true, filters = {}, orderNumber = '', shopId = '' }) {
  const [data, setData] = useState([]), [settings, setSettings] = useState(null), [detail, setDetail] = useState(null);
  const [selectedId, setSelectedId] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false);
  const query = toQuery({ shopId: shopId || filters.shopId || '', orderNumber });
  useEffect(() => {
    if (!isOwner) return undefined;
    let cancelled = false, running = false;
    const load = async () => {
      if (running) return; running = true;
      try {
        const [s, cases, current] = await Promise.all([api('/api/v1/chat-analysis/settings'), api(`/api/v1/chat-analysis/cases?${query}`), selectedId ? api(`/api/v1/chat-analysis/cases/${selectedId}`) : Promise.resolve(null)]);
        if (!cancelled) { setSettings(s.data); setData(cases.data); setDetail(current?.data || null); setError(null); }
      } catch (e) { if (!cancelled) setError(e); } finally { running = false; }
    };
    load(); const timer = setInterval(load, 10000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [isOwner, query, selectedId]);
  if (!isOwner) return null;
  const recollect = async (id) => {
    setBusy(true);
    try { await ownerRequest(`/api/v1/chat-analysis/cases/${id}/recollect`, owner.csrfToken, { method: 'POST', body: '{}' }); setDetail((d) => d ? { ...d, collect_requested: true } : d);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const setMode = async (mode) => {
    setBusy(true);
    try { const r = await ownerRequest('/api/v1/chat-analysis/settings', owner.csrfToken, { method: 'PATCH', body: JSON.stringify({ mode, approveAutomaticFeedback: mode === 'auto-feedback' }) }); setSettings((s) => ({ ...s, mode: r.data.mode }));
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const deleteCase = async (id) => { if (!window.confirm('确认删除这条聊天记录及其分析证据？')) return; setBusy(true); try { await ownerRequest(`/api/v1/chat-analysis/cases/${id}`, owner.csrfToken, { method: 'DELETE' }); setSelectedId(null); setDetail(null); setData((rows) => rows.filter((r) => r.id !== id)); } catch (e) { setError(e); } finally { setBusy(false); } };
  const clearAll = async () => { if (!window.confirm('确认清理全部聊天记录、快照、附件和分析结果？此操作不可恢复。')) return; setBusy(true); try { await ownerRequest('/api/v1/chat-analysis/cases', owner.csrfToken, { method: 'DELETE' }); setData([]); setDetail(null); setSelectedId(null); } catch (e) { setError(e); } finally { setBusy(false); } };
  const job = detail?.jobs?.[0], result = job?.result, snapshot = detail?.snapshot?.payload;
  const evidenceIds = new Set((result?.analysis?.evidence || []).map((e) => e.messageId));
  const evidenceMessages = (snapshot?.messages || []).filter((message) => evidenceIds.has(message.id));
  return <div className="chat-analysis view-stack">
    <div className="view-heading"><div><span className="eyebrow">CHAT ANALYSIS</span><h1><MessageSquareText size={24} /> 聊天分析</h1><p>查看所有需要聊天判断的工单、完整分页覆盖和模型引用证据</p></div>
      {!orderNumber && <div className="heading-actions"><select aria-label="聊天分析运行模式" disabled={busy || !settings?.enabled} value={settings?.mode || 'off'} onChange={(e) => setMode(e.target.value)}><option value="off">关闭</option><option value="analyze-only">仅分析</option><option value="auto-feedback">自动执行</option></select><button className="button" disabled={busy || !data.length} onClick={clearAll}>清理全部记录</button></div>}</div>
    {error && <ErrorBanner error={error} onClose={() => setError(null)} />}
    <div className="chat-mode-note">{settings?.mode === 'auto-feedback' ? '已开启：符合证据规则的“没有少发”和“真的少发”工单会自动执行完整流程。' : settings?.mode === 'off' ? '聊天分析已关闭。' : '仅展示分析结论与依据，尚未自动提交工单。'}<span>{settings?.configured ? settings.model : '模型未配置'}</span></div>
    {detail ? <>
      <div className="heading-actions"><button className="button" onClick={() => setSelectedId(null)}><ChevronLeft size={16} />返回列表</button><button className="button" disabled={busy || detail.collect_requested} onClick={() => recollect(detail.id)}><RefreshCw size={16} />{detail.collect_requested ? '已排队重新提取' : '重新提取并分析'}</button><button className="button" disabled={busy} onClick={() => deleteCase(detail.id)}>删除记录</button></div>
      <section className="chat-result-card"><h2>{detail.shop_name} · {detail.order_number}</h2><p>平台工单：{detail.platform_case_id} · 工单类型：{detail.work_order_type || detail.scenario_code || '未标注'}</p><strong>{result?.policy?.label || states[detail.status] || '等待分析'}</strong><p>{result?.analysis?.summary || errors[job?.error_code] || job?.error_code || detail.last_error || '正在等待店铺浏览器采集聊天记录'}</p>
        <p>采集完整性：{snapshot?.completeness?.complete ? '已确认完整' : '尚未确认完整'} · 共 {snapshot?.messages?.length || 0} 条 · 证据 {evidenceMessages.length} 条 · 查询页 {[...new Set((snapshot?.messages || []).map((m) => m.source?.page).filter(Boolean))].sort((a, b) => a - b).join('、') || '未读取'}</p>
        {[...new Set([...(snapshot?.completeness?.issues || []), ...(result?.policy?.issues || []), ...(result?.analysis?.conflicts || []), ...(result?.analysis?.missing || [])])].map((s, i) => <p className="chat-issue" key={i}>{typeof s === 'string' ? s : JSON.stringify(s)}</p>)}
        <details><summary>订单事实</summary><pre>{snapshot?.orderFacts?.orderDetailText || '未读取'}</pre></details></section>
      <section className="chat-message-list"><h3>模型结论证据 <small>完整原始会话仍保存在快照中，此处只展示模型实际引用的消息</small></h3>{evidenceMessages.length ? evidenceMessages.map((m) => <article className="chat-message cited" key={m.id}>
        <header><strong>{({ buyer: '买家', seller: '客服', system: '系统', unknown: '身份待核实' })[m.role]} · {m.speaker}</strong><time>{m.timestamp}</time></header><p>{m.text || m.rawText || '（未读取到正文）'}</p>
        {(m.attachments || []).map((a) => a.status === 'ready' ? <a key={a.id} href={`/api/v1/chat-analysis/snapshots/${detail.snapshot.id}/attachments/${a.id}`} target="_blank" rel="noopener" referrerPolicy="same-origin"><img alt="聊天图片证据" loading="lazy" src={`/api/v1/chat-analysis/snapshots/${detail.snapshot.id}/attachments/${a.id}`} /></a> : <span key={a.id}>图片未能读取</span>)}<small>查询页 {m.source?.page} · 消息 {m.id}</small></article>) : <EmptyState title="暂无可核验证据" description="模型尚未引用能够证明当前结论的聊天原文。" />}</section>
    </> : <section className="table-section">{data.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>店铺 / 订单号</th><th>工单类型</th><th>状态</th><th>判断</th><th>依据</th><th>更新时间</th><th /></tr></thead><tbody>{data.map((c) => <tr key={c.id}><td>{c.shop_name}<br /><span className="mono">{c.order_number}</span></td><td>{c.work_order_type || c.scenario_code || '未标注'}</td><td>{states[c.status] || c.status}</td><td>{c.result?.policy?.label || '待分析'}</td><td className="chat-summary-cell">{c.result?.analysis?.summary || errors[c.error_code] || c.error_code || c.last_error || '等待聊天采集或模型分析'}</td><td>{formatDateTime(c.updated_at)}</td><td><button className="button" onClick={() => setSelectedId(c.id)}>查看依据</button></td></tr>)}</tbody></table></div> : <EmptyState title="暂无聊天分析记录" description="店铺将在业务任务间隙提取已登记聊天规则的工单记录。" />}</section>}
  </div>;
}
