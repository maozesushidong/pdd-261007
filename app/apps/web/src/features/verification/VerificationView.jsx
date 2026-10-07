import React, { useEffect, useState } from 'react';
import { CheckCircle2, Crosshair, ExternalLink, Frame, LockOpen, MapPin, RefreshCw, RotateCw, ScanLine, Store, Trash2 } from 'lucide-react';
import { api, ownerRequest } from '../../services/api.js';
import { EmptyState, LoadingBlock, StatusBadge } from '../../components/Common.jsx';
import { formatDateTime, labelShop } from '../../app/format.js';

function LocatorImage({ item }) {
  const [naturalSize, setNaturalSize] = useState(null);
  const box = item.boundingBox || {};
  const overlay = naturalSize ? {
    left: `${(Number(box.x || 0) / naturalSize.width) * 100}%`,
    top: `${(Number(box.y || 0) / naturalSize.height) * 100}%`,
    width: `${(Number(box.width || 0) / naturalSize.width) * 100}%`,
    height: `${(Number(box.height || 0) / naturalSize.height) * 100}%`,
  } : null;
  if (!item.screenshotUrl) {
    return <div className="verification-placeholder"><ScanLine size={38} /><strong>诊断截图待同步</strong><span>{item.selector || '已记录页面级验证状态'}</span></div>;
  }
  return <div className="verification-canvas">
    <img
      src={item.screenshotUrl}
      alt={`${labelShop(item.shopId)} 验证码位置`}
      onLoad={(event) => setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
    />
    {overlay && <div className="locator-box" style={overlay}><span>验证位置</span></div>}
  </div>;
}

const isWaitingVerification = (item) => item.active === true;
const isResolvedVerification = (item) => item.status === 'resolved' || Boolean(item.resolvedAt);

export default function VerificationView({ filters, owner, isOwner, refreshVersion, refresh, setError }) {
  const [items, setItems] = useState([]);
  const [statusFilter, setStatusFilter] = useState('waiting');
  const [loading, setLoading] = useState(true);
  const [selectedScreenshotIds, setSelectedScreenshotIds] = useState(new Set());
  const [deletingScreenshots, setDeletingScreenshots] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api('/api/v1/verifications')
      .then((result) => {
        if (cancelled) return;
        const nextItems = (result.data || []).filter((item) => !filters.shopId || item.shopId === filters.shopId);
        setItems(nextItems);
        const availableIds = new Set(nextItems.filter((item) => item.screenshotUrl).map((item) => item.id));
        setSelectedScreenshotIds((current) => new Set([...current].filter((id) => availableIds.has(id))));
      })
      .catch((error) => !cancelled && setError(error))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [filters.shopId, refreshVersion, setError]);

  const requestRecheck = async (id) => {
    try {
      await ownerRequest(`/api/v1/verifications/${id}/recheck`, owner.csrfToken, { method: 'POST', body: '{}' });
      refresh();
    } catch (error) { setError(error); }
  };

  const refreshAndNext = async (id) => {
    if (!window.confirm('确认刷新当前业务页面、挂起这张工单并立即处理下一单？')) return;
    try {
      await ownerRequest(`/api/v1/verifications/${id}/refresh-next`, owner.csrfToken, {
        method: 'POST',
        body: JSON.stringify({ reason: '所有者从验证码中心刷新页面并切换下一单' }),
      });
      setItems((current) => current.map((item) => item.id === id ? { ...item, handoffStatus: 'pending' } : item));
      refresh();
    } catch (error) { setError(error); }
  };

  const forceClear = async (id) => {
    if (!window.confirm('仅在当前页面确实没有验证码时使用。确认强制解除等待并继续处理当前工单？')) return;
    try {
      await ownerRequest(`/api/v1/verifications/${id}/force-clear`, owner.csrfToken, {
        method: 'POST',
        body: JSON.stringify({ reason: '所有者确认页面已无验证码，强制解除并继续当前工单' }),
      });
      setItems((current) => current.map((item) => item.id === id ? { ...item, forceClearStatus: 'pending' } : item));
      refresh();
    } catch (error) { setError(error); }
  };

  const deleteScreenshot = async (id) => {
    if (!window.confirm('确认删除这张验证定位截图？删除后图片文件无法恢复。')) return;
    try {
      await ownerRequest(`/api/v1/verifications/${id}/screenshot`, owner.csrfToken, {
        method: 'DELETE',
        body: JSON.stringify({ reason: '系统所有者从验证定位中心删除截图' }),
      });
      setItems((current) => current.map((item) => item.id === id ? { ...item, screenshotUrl: null } : item));
      refresh();
    } catch (error) { setError(error); }
  };

  const waitingCount = items.filter(isWaitingVerification).length;
  const resolvedCount = items.filter(isResolvedVerification).length;
  const visibleItems = items.filter((item) => statusFilter === 'all'
    || (statusFilter === 'waiting' ? isWaitingVerification(item) : isResolvedVerification(item)));
  const screenshotItems = visibleItems.filter((item) => item.screenshotUrl);
  const selectedIds = screenshotItems.filter((item) => selectedScreenshotIds.has(item.id)).map((item) => item.id);
  const allScreenshotsSelected = screenshotItems.length > 0 && selectedIds.length === screenshotItems.length;
  const toggleScreenshot = (id, checked) => setSelectedScreenshotIds((current) => {
    const next = new Set(current);
    if (checked) next.add(id); else next.delete(id);
    return next;
  });
  const toggleAllScreenshots = (checked) => setSelectedScreenshotIds(
    checked ? new Set(screenshotItems.map((item) => item.id)) : new Set(),
  );
  const deleteScreenshotBatch = async (ids, mode) => {
    if (!ids.length) return;
    const label = mode === 'all' ? `当前列表全部 ${ids.length} 张` : `选中的 ${ids.length} 张`;
    if (!window.confirm(`确认删除${label}验证定位截图？删除后图片文件无法恢复。`)) return;
    setDeletingScreenshots(true);
    try {
      await ownerRequest('/api/v1/verifications/screenshots/bulk-delete', owner.csrfToken, {
        method: 'POST',
        body: JSON.stringify({ ids, reason: `系统所有者批量删除${label}验证定位截图` }),
      });
      const deletedIds = new Set(ids);
      setItems((current) => current.map((item) => deletedIds.has(item.id) ? { ...item, screenshotUrl: null } : item));
      setSelectedScreenshotIds((current) => new Set([...current].filter((id) => !deletedIds.has(id))));
      refresh();
    } catch (error) {
      setError(error);
    } finally {
      setDeletingScreenshots(false);
    }
  };

  return <div className="view-stack">
    <div className="view-heading"><div><span className="eyebrow">VERIFICATION LOCATOR</span><h1>验证码与滑块定位</h1><p>按店铺、系统和坐标定位人工验证区域</p></div></div>
    <section className="verification-filterbar" aria-label="验证状态筛选">
      <div className="segmented">
        <button type="button" className={statusFilter === 'waiting' ? 'active' : ''} onClick={() => setStatusFilter('waiting')}><ScanLine size={16} />当前等待 <span>{waitingCount}</span></button>
        <button type="button" className={statusFilter === 'resolved' ? 'active' : ''} onClick={() => setStatusFilter('resolved')}><CheckCircle2 size={16} />已解决 <span>{resolvedCount}</span></button>
        <button type="button" className={statusFilter === 'all' ? 'active' : ''} onClick={() => setStatusFilter('all')}>全部 <span>{items.length}</span></button>
      </div>
    </section>
    {isOwner && screenshotItems.length > 0 && <section className="verification-bulkbar"><label><input type="checkbox" aria-label="全选验证截图" checked={allScreenshotsSelected} onChange={(event) => toggleAllScreenshots(event.target.checked)} /><span>全选截图</span></label><span>共 {screenshotItems.length} 张，已选 {selectedIds.length} 张</span><div><button className="button" disabled={!selectedIds.length || deletingScreenshots} onClick={() => deleteScreenshotBatch(selectedIds, 'selected')}><Trash2 size={15} />删除选中 ({selectedIds.length})</button><button className="button danger" disabled={deletingScreenshots} onClick={() => deleteScreenshotBatch(screenshotItems.map((item) => item.id), 'all')}><Trash2 size={15} />删除全部 ({screenshotItems.length})</button></div></section>}
    {loading ? <LoadingBlock /> : visibleItems.length ? <div className="verification-grid">{visibleItems.map((item) => <article className="verification-panel" key={item.id}>
      <header><div><span className={`system-logo ${item.system}`}>{String(item.system || 'pdd').toUpperCase()}</span><div><strong>{labelShop(item.shopId)}</strong><span>{item.stage}</span></div></div><div className="verification-panel-status">{isOwner && item.screenshotUrl && <input type="checkbox" aria-label={`选择 ${labelShop(item.shopId)} ${formatDateTime(item.detectedAt)} 的验证截图`} checked={selectedScreenshotIds.has(item.id)} onChange={(event) => toggleScreenshot(item.id, event.target.checked)} />}<StatusBadge status={item.status === 'waiting-human' ? 'verification' : item.status} /></div></header>
      <LocatorImage item={item} />
      <div className="verification-info"><div><Store size={15} /><span>系统</span><strong>{String(item.system || 'pdd').toUpperCase()}</strong></div><div><MapPin size={15} /><span>坐标</span><strong>x {item.boundingBox?.x ?? '-'} · y {item.boundingBox?.y ?? '-'}</strong></div><div><Crosshair size={15} /><span>范围</span><strong>{item.boundingBox?.width ?? '-'} × {item.boundingBox?.height ?? '-'}</strong></div><div><Frame size={15} /><span>置信度</span><strong>{item.confidence || '-'}</strong></div></div>
      <div className="verification-url"><span>{item.frameUrl ? 'iframe' : '页面'}</span><code>{item.frameUrl || item.url}</code><a href={item.url} target="_blank" rel="noreferrer" title="打开页面"><ExternalLink size={15} /></a></div>
      <footer><span>检测于 {formatDateTime(item.detectedAt)}</span><div className="verification-actions">
        {isOwner && item.screenshotUrl && <button className="button" onClick={() => deleteScreenshot(item.id)}><Trash2 size={15} />删除截图</button>}
        {isOwner && item.workOrderId && ['detected', 'waiting-human'].includes(item.status) && <button className="button" disabled={['pending', 'delivered'].includes(item.forceClearStatus)} onClick={() => forceClear(item.id)}><LockOpen size={15} />{['pending', 'delivered'].includes(item.forceClearStatus) ? '正在强制解除' : '强制解除并继续'}</button>}
        {isOwner && item.workOrderId && ['detected', 'waiting-human'].includes(item.status) && <button className="button danger" disabled={['pending', 'delivered'].includes(item.handoffStatus)} onClick={() => refreshAndNext(item.id)}><RefreshCw size={15} />{['pending', 'delivered'].includes(item.handoffStatus) ? '正在切换下一单' : '刷新并切下一单'}</button>}
        {isOwner && ['detected', 'waiting-human'].includes(item.status) && <button className="button primary" disabled={item.recheckStatus === 'pending'} onClick={() => requestRecheck(item.id)}><RotateCw size={15} />{item.recheckStatus === 'pending' ? '已请求复检' : '人工完成后复检'}</button>}
      </div></footer>
    </article>)}</div> : <EmptyState title={statusFilter === 'waiting' ? '当前没有等待处理的验证码或滑块' : statusFilter === 'resolved' ? '当前没有已解决的验证记录' : '当前没有验证记录'} />}
  </div>;
}
