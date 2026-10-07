import React, { useEffect, useMemo, useState } from 'react';
import { Check, Copy, ExternalLink, Send } from 'lucide-react';
import { api, ownerRequest } from '../services/api.js';
import { labelShop } from '../app/format.js';
import { ErrorBanner, Modal } from './Common.jsx';

const initialMessage = (workOrder) => {
  const analysis = workOrder?.incompleteAnalysis || {};
  return {
    problemZh: analysis.reasonZh || analysis.reason || '自动流程未完成，需要人工核查。',
    descriptionZh: analysis.descriptionZh || analysis.reasonZh || analysis.reason || '自动流程未完成，需要人工核查。',
    descriptionEn: analysis.descriptionEn || analysis.reasonEn || 'The automated workflow did not complete and requires manual review.',
  };
};

const copyText = async (value) => {
  const text = String(value || '');
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('浏览器未允许复制，请手动选择内容。');
};

const imageBlobAsPng = async (blob) => {
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob(
    (png) => png ? resolve(png) : reject(new Error('图片转换失败')),
    'image/png',
  ));
};

const detailValue = (detail, ...paths) => paths.map((path) => path.reduce(
  (value, key) => value?.[key],
  detail,
)).find((value) => String(value || '').trim()) || null;

export default function DingTalkMessageDialog({ workOrder, owner, onClose, onSent }) {
  const [message, setMessage] = useState(() => initialMessage(workOrder));
  const [detail, setDetail] = useState(workOrder);
  const [copyStatus, setCopyStatus] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (!workOrder?.id || workOrder.scenarioCode === 'return-refund' || workOrder.scenario_code === 'return-refund') return undefined;
    api(`/api/v1/work-orders/${workOrder.id}`)
      .then((response) => { if (!cancelled && response.data) setDetail(response.data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [workOrder]);
  const update = (field, value) => setMessage((current) => ({ ...current, [field]: value }));
  const submit = async (event) => {
    event.preventDefault();
    setSending(true);
    setError(null);
    try {
      const result = await ownerRequest(`/api/v1/work-orders/${workOrder.id}/dingtalk`, owner.csrfToken, {
        method: 'POST',
        body: JSON.stringify({ message }),
      });
      onSent(result.data);
      onClose();
    } catch (requestError) {
      setError(requestError);
    } finally {
      setSending(false);
    }
  };
  const valid = message.problemZh.trim() && message.descriptionZh.trim() && message.descriptionEn.trim();
  const orderNumber = workOrder.orderNumber || workOrder.external_order_number || '-';
  const returnRefund = (detail.scenarioCode || detail.scenario_code) === 'return-refund';
  const shopName = detail.shopName || detailValue(detail, ['payload', 'shopNameSnapshot'])
    || labelShop(detail);
  const workOrderType = detail.workOrderType || detail.work_order_type
    || detailValue(detail, ['payload', 'manualOverrides', 'workOrderType'], ['payload', 'workOrderType']) || '未读取';
  const warehouse = detail.warehouse || detailValue(
    detail,
    ['warehouseInfo', 'omsValue'],
    ['oms', 'shippingWarehouse'],
    ['oms', 'matchedWarehouse'],
    ['payload', 'omsAnalysis', 'shippingWarehouse'],
    ['payload', 'omsWarehouseParse', 'parsedValue'],
  ) || '未读取';
  const tmsEvidence = useMemo(() => (detail.evidence || []).find((asset) => (
    asset.kind === 'tms-evidence' && asset.status === 'ready' && !asset.deleted_at
  )) || null, [detail.evidence]);
  const tmsEvidenceUrl = tmsEvidence?.id
    ? `/api/v1/evidence/${encodeURIComponent(tmsEvidence.id)}/content`
    : null;
  const copyFields = [
    ['店铺', shopName],
    ['订单号', detail.orderNumber || detail.external_order_number || orderNumber],
    ['工单类型', workOrderType],
    ['OMS发货仓库', warehouse],
  ];
  const runCopy = async (action, successMessage) => {
    setCopyStatus('');
    try {
      const actionMessage = await action();
      setCopyStatus(actionMessage || successMessage);
    } catch (copyError) {
      setCopyStatus(copyError.message || '复制失败，请手动选择内容。');
    }
  };
  const copyAll = () => runCopy(
    () => copyText([
      ...copyFields.map(([label, value]) => `${label}：${value}`),
      `TMS凭证图片：${tmsEvidenceUrl ? new URL(tmsEvidenceUrl, window.location.origin).toString() : '未生成或暂不可访问'}`,
    ].join('\n')),
    '人工处理信息已全部复制',
  );
  const copyImage = () => runCopy(async () => {
    const absoluteUrl = new URL(tmsEvidenceUrl, window.location.origin).toString();
    if (!window.ClipboardItem || !navigator.clipboard?.write) {
      await copyText(absoluteUrl);
      return '浏览器不支持复制图片，已复制原图链接';
    }
    const response = await fetch(tmsEvidenceUrl, { credentials: 'include' });
    if (!response.ok) throw new Error('TMS 凭证图片读取失败');
    const png = await imageBlobAsPng(await response.blob());
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  }, 'TMS 凭证图片已复制');
  return <Modal title={`推送钉钉 · ${orderNumber}`} onClose={sending ? undefined : onClose} width={680}>
    <form className="form-stack dingtalk-message-form" onSubmit={submit}>
      <ErrorBanner error={error} />
      {!returnRefund && <section className="manual-copy-panel" aria-label="人工处理信息">
        <header><div><strong>人工处理信息</strong><span>发送前可逐项复制，钉钉通知中保持相同顺序</span></div><button type="button" className="button" onClick={copyAll}><Copy size={15} />全部复制</button></header>
        <div className="manual-copy-fields">{copyFields.map(([label, value]) => <div key={label}><span>{label}</span><code>{value}</code><button type="button" className="icon-button" aria-label={`复制${label}`} title={`复制${label}`} onClick={() => runCopy(() => copyText(value), `${label}已复制`)}><Copy size={14} /></button></div>)}</div>
        <div className="manual-copy-evidence">
          <span>TMS凭证图片</span>
          {tmsEvidenceUrl ? <><a href={tmsEvidenceUrl} target="_blank" rel="noopener" referrerPolicy="same-origin" title="打开 TMS 凭证原图"><img src={tmsEvidenceUrl} alt="TMS凭证图片" /></a><div><button type="button" className="button" onClick={copyImage}><Copy size={15} />复制图片</button><a className="button" href={tmsEvidenceUrl} target="_blank" rel="noopener" referrerPolicy="same-origin"><ExternalLink size={15} />打开原图</a></div></> : <strong>未生成或暂不可访问</strong>}
        </div>
        {copyStatus && <p className="manual-copy-status" role="status"><Check size={14} />{copyStatus}</p>}
      </section>}
      <label><span>问题（中文）</span><textarea rows="2" required maxLength={100} value={message.problemZh} onChange={(event) => update('problemZh', event.target.value)} /><small>{message.problemZh.length}/100</small></label>
      <label><span>未完成流程分析（中文）</span><textarea rows="3" required maxLength={220} value={message.descriptionZh} onChange={(event) => update('descriptionZh', event.target.value)} /><small>{message.descriptionZh.length}/220</small></label>
      <label><span>Incomplete workflow analysis (English)</span><textarea rows="4" required maxLength={260} value={message.descriptionEn} onChange={(event) => update('descriptionEn', event.target.value)} /><small>{message.descriptionEn.length}/260</small></label>
      <div className="modal-actions"><button type="button" className="button" onClick={onClose} disabled={sending}>取消</button><button className="button primary" disabled={sending || !valid}><Send size={16} />{sending ? '正在推送...' : '确认推送'}</button></div>
    </form>
  </Modal>;
}
