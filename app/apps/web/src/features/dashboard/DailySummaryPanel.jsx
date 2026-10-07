import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Clock3, FilePenLine, Save, Send } from 'lucide-react';
import { ownerRequest } from '../../services/api.js';
import { ErrorBanner, LoadingBlock, Modal, StatusBadge } from '../../components/Common.jsx';
import { formatDateTime } from '../../app/format.js';

const statusLabels = {
  pending: '待发送',
  sending: '发送中',
  sent: '已发送',
  failed: '发送失败',
};

export default function DailySummaryPanel({ owner, refreshVersion, setError }) {
  const [summary, setSummary] = useState(null);
  const [messageText, setMessageText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [automaticUpdating, setAutomaticUpdating] = useState(false);
  const [automaticSettings, setAutomaticSettings] = useState({ enabled: false, startDate: null });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [localError, setLocalError] = useState(null);
  const serverMessageRef = useRef('');
  const editingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load = () => Promise.all([
      ownerRequest('/api/v1/dingtalk/daily-summary', owner.csrfToken),
      ownerRequest('/api/v1/settings', owner.csrfToken),
    ])
      .then(([result, settingsResult]) => {
        if (cancelled) return;
        const incoming = result.data || null;
        const incomingSettings = settingsResult.data || {};
        const incomingMessage = incoming?.messageText || '';
        setAutomaticSettings({
          enabled: incomingSettings.dingtalkDailySummaryAutomaticEnabled === true,
          startDate: incomingSettings.dingtalkDailySummaryAutomaticStartDate || null,
        });
        if (editingRef.current) return;
        setSummary(incoming);
        setMessageText((currentMessage) => {
          const previousServerMessage = serverMessageRef.current;
          serverMessageRef.current = incomingMessage;
          return currentMessage === previousServerMessage ? incomingMessage : currentMessage;
        });
        setLocalError(null);
      })
      .catch((error) => {
        if (!cancelled) {
          setLocalError(error);
          setError(error);
        }
      })
      .finally(() => !cancelled && setLoading(false));
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [owner.csrfToken, refreshVersion, setError]);

  const normalizedMessage = messageText.trim();
  const dirty = Boolean(summary && normalizedMessage !== String(summary.messageText || '').trim());
  const editable = summary && !['sending', 'sent'].includes(summary.status);
  const canSubmit = editable && normalizedMessage.length > 0 && normalizedMessage.length <= 2000;
  const preview = useMemo(() => {
    const lines = normalizedMessage
      .split(/\r?\n/gu)
      .map((line) => line.replace(/^\s*[-*·•]\s*/u, '').trim())
      .filter(Boolean);
    return ['Agent 工单执行汇报', '', ...lines.map((line) => `• ${line}`)].join('\n');
  }, [normalizedMessage]);

  const save = async () => {
    if (!canSubmit || !dirty) return;
    setSaving(true);
    setLocalError(null);
    try {
      const result = await ownerRequest(
        `/api/v1/dingtalk/daily-summary/${summary.summaryDate}`,
        owner.csrfToken,
        { method: 'PATCH', body: JSON.stringify({ messageText: normalizedMessage }) },
      );
      setSummary(result.data);
      setMessageText(result.data.messageText);
      serverMessageRef.current = result.data.messageText;
      editingRef.current = false;
    } catch (error) {
      setLocalError(error);
    } finally {
      setSaving(false);
    }
  };

  const send = async () => {
    if (!canSubmit) return;
    setSending(true);
    setLocalError(null);
    try {
      const result = await ownerRequest(
        `/api/v1/dingtalk/daily-summary/${summary.summaryDate}/send`,
        owner.csrfToken,
        { method: 'POST', body: JSON.stringify({ messageText: normalizedMessage }) },
      );
      setSummary(result.data);
      setMessageText(result.data.messageText);
      serverMessageRef.current = result.data.messageText;
      editingRef.current = false;
      setConfirmOpen(false);
    } catch (error) {
      setLocalError(error);
      setConfirmOpen(false);
    } finally {
      setSending(false);
    }
  };

  const toggleAutomatic = async () => {
    setAutomaticUpdating(true);
    setLocalError(null);
    try {
      const result = await ownerRequest(
        '/api/v1/settings/dingtalk-daily-summary',
        owner.csrfToken,
        {
          method: 'PATCH',
          body: JSON.stringify({ automaticEnabled: !automaticSettings.enabled }),
        },
      );
      const settings = result.data || {};
      setAutomaticSettings({
        enabled: settings.dingtalkDailySummaryAutomaticEnabled === true,
        startDate: settings.dingtalkDailySummaryAutomaticStartDate || null,
      });
    } catch (error) {
      setLocalError(error);
    } finally {
      setAutomaticUpdating(false);
    }
  };

  return <>
    <section className="daily-summary-panel section-block">
    <div className="section-heading">
      <div><h2>今日钉钉汇总</h2><span>{summary
        ? `${summary.summaryDate} · 统计持续更新${summary.statisticsRefreshedAt ? ` · 最近更新 ${formatDateTime(summary.statisticsRefreshedAt)}` : ''}`
        : '统计持续更新，18:25 固定刷新一次'}</span></div>
      <div className="daily-summary-heading-actions">
        <div className="daily-summary-automatic-control">
          <button
            type="button"
            role="switch"
            aria-checked={automaticSettings.enabled}
            className={`compact-switch ${automaticSettings.enabled ? 'enabled' : ''}`}
            disabled={automaticUpdating}
            onClick={toggleAutomatic}
          ><span /></button>
          <div><strong>每天 18:30 自动发送</strong><small>{automaticSettings.enabled
            ? `${automaticSettings.startDate || '下个汇总日'}起生效`
            : '已关闭'}</small></div>
        </div>
        {summary && <StatusBadge status={summary.status} label={statusLabels[summary.status] || summary.status} />}
      </div>
    </div>
    {loading ? <LoadingBlock label="正在读取今日汇总" /> : !summary ? <div className="daily-summary-empty">
      <Clock3 size={22} />
      <div><strong>今日草稿正在生成</strong><span>稍后即可编辑并发送</span></div>
    </div> : <div className="daily-summary-body">
      <ErrorBanner error={localError} onClose={() => setLocalError(null)} />
      <div className="daily-summary-counts">
        <div><span>今日Agent已处理单量</span><strong>{summary.todayProcessed}</strong><small>单</small></div>
        <div><span>Agent历史总处理单量</span><strong>{summary.historicalProcessed}</strong><small>单</small></div>
        <div className="daily-summary-meta">
          {summary.status === 'sent' ? <CheckCircle2 size={18} /> : <FilePenLine size={18} />}
          <span>{dirty
            ? '正在编辑，统计刷新已暂停；保存或发送后恢复'
            : summary.status === 'sent'
            ? `发送时间 ${formatDateTime(summary.sentAt)}`
            : summary.editedAt ? `最后编辑 ${formatDateTime(summary.editedAt)}` : '系统生成草稿'}</span>
        </div>
      </div>
      <label className="daily-summary-editor">
        <span>群通知数据</span>
        <textarea
          rows="5"
          maxLength={2000}
          value={messageText}
          disabled={!editable}
          onChange={(event) => {
            const nextMessage = event.target.value;
            editingRef.current = nextMessage.trim() !== serverMessageRef.current.trim();
            setMessageText(nextMessage);
          }}
        />
        <small>{messageText.length}/2000</small>
      </label>
      <div className="daily-summary-actions">
        <button type="button" className="button" disabled={!canSubmit || !dirty || saving || sending} onClick={save}>
          <Save size={16} />{saving ? '保存中' : '保存草稿'}
        </button>
        <button type="button" className="button primary" disabled={!canSubmit || saving || sending || summary.status === 'sent'} onClick={() => setConfirmOpen(true)}>
          <Send size={16} />{summary.status === 'sent' ? '今日已发送' : '发送到钉钉群'}
        </button>
      </div>
    </div>}
    </section>
    {confirmOpen && <Modal title="确认发送今日汇总" width={720} onClose={sending ? undefined : () => setConfirmOpen(false)}>
      <div className="daily-summary-confirm">
        <strong>钉钉群内将按以下版式显示</strong>
        <pre>{preview}</pre>
        <div className="modal-actions">
          <button type="button" className="button" disabled={sending} onClick={() => setConfirmOpen(false)}>取消</button>
          <button type="button" className="button primary" disabled={sending} onClick={send}>
            <Send size={16} />{sending ? '发送中' : '确认发送'}
          </button>
        </div>
      </div>
    </Modal>}
  </>;
}
