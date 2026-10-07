import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronLeft, ChevronRight, Crosshair, Eye, Frame, MapPin, ScanLine, Store } from 'lucide-react';
import { EmptyState, LoadingBlock, StatusBadge } from './Common.jsx';
import { formatDateTime, labelShop, labelStage } from '../app/format.js';
import { publicApi, publicResourceUrl } from '../services/public-api.js';

function LocatorImage({ item }) {
  const [naturalSize, setNaturalSize] = useState(null);
  const box = item.boundingBox || {};
  const overlay = naturalSize && Number(box.width) > 0 && Number(box.height) > 0 ? {
    left: `${(Number(box.x || 0) / naturalSize.width) * 100}%`,
    top: `${(Number(box.y || 0) / naturalSize.height) * 100}%`,
    width: `${(Number(box.width || 0) / naturalSize.width) * 100}%`,
    height: `${(Number(box.height || 0) / naturalSize.height) * 100}%`,
  } : null;
  if (!item.screenshotUrl) return <div className="verification-placeholder"><ScanLine size={38} /><strong>定位截图待同步</strong><span>验证状态已经记录</span></div>;
  return <div className="verification-canvas"><img loading="lazy" decoding="async" src={publicResourceUrl(item.screenshotUrl)} alt={`${labelShop(item)} 验证码位置`} onLoad={(event) => setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />{overlay && <div className="locator-box" style={overlay}><span>验证位置</span></div>}</div>;
}

const waiting = (item) => item.active === true;
const resolved = (item) => item.status === 'resolved' || Boolean(item.resolvedAt);

export default function PublicVerificationView({ filters, refreshVersion, setError, onOpenWorkOrder }) {
  const [items, setItems] = useState([]);
  const [statusFilter, setStatusFilter] = useState('waiting');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    publicApi('/api/v1/verifications')
      .then((response) => { if (!cancelled) setItems(response.data || []); })
      .catch((requestError) => { if (!cancelled) setError(requestError); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshVersion, setError]);

  const scopedItems = useMemo(() => items.filter((item) => !filters.shopId || item.shopId === filters.shopId), [items, filters.shopId]);
  const waitingCount = scopedItems.filter(waiting).length;
  const resolvedCount = scopedItems.filter(resolved).length;
  const filteredItems = scopedItems.filter((item) => statusFilter === 'all' || (statusFilter === 'waiting' ? waiting(item) : resolved(item)));
  const pageSize = 20;
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleItems = filteredItems.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const chooseStatus = (status) => { setStatusFilter(status); setPage(1); };

  return <div className="view-stack">
    <div className="view-heading"><div><span className="eyebrow">VERIFICATION LOCATOR</span><h1>验证码与滑块定位</h1><p>查看触发店铺、系统、截图和页面坐标</p></div></div>
    <section className="verification-filterbar" aria-label="验证状态筛选"><div className="segmented"><button type="button" className={statusFilter === 'waiting' ? 'active' : ''} onClick={() => chooseStatus('waiting')}><ScanLine size={16} />当前等待 <span>{waitingCount}</span></button><button type="button" className={statusFilter === 'resolved' ? 'active' : ''} onClick={() => chooseStatus('resolved')}><CheckCircle2 size={16} />已解决 <span>{resolvedCount}</span></button><button type="button" className={statusFilter === 'all' ? 'active' : ''} onClick={() => chooseStatus('all')}>全部 <span>{scopedItems.length}</span></button></div></section>
    {loading ? <LoadingBlock /> : visibleItems.length ? <><div className="verification-grid public-verification-grid">{visibleItems.map((item) => <article className="verification-panel" key={item.id}><header><div><span className={`system-logo ${item.system}`}>{String(item.system || 'pdd').toUpperCase()}</span><div><strong>{labelShop(item)}</strong><span>{labelStage(item.stage)}</span></div></div><div className="verification-panel-status"><StatusBadge status={item.active ? 'verification' : item.status} label={item.active ? '等待验证' : undefined} /></div></header><LocatorImage item={item} /><div className="verification-info"><div><Store size={15} /><span>系统</span><strong>{String(item.system || 'pdd').toUpperCase()}</strong></div><div><MapPin size={15} /><span>坐标</span><strong>x {item.boundingBox?.x ?? '-'} · y {item.boundingBox?.y ?? '-'}</strong></div><div><Crosshair size={15} /><span>范围</span><strong>{item.boundingBox?.width ?? '-'} × {item.boundingBox?.height ?? '-'}</strong></div><div><Frame size={15} /><span>置信度</span><strong>{item.confidence || '-'}</strong></div></div><footer><span>检测于 {formatDateTime(item.detectedAt)}{item.resolvedAt ? ` · 解决于 ${formatDateTime(item.resolvedAt)}` : ''}</span>{item.workOrderId ? <button className="button public-view-detail" onClick={() => onOpenWorkOrder(item.workOrderId)}><Eye size={15} />查看工单</button> : null}</footer></article>)}</div><div className="pagination"><button className="icon-button" aria-label="上一页" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={18} /></button><span>{currentPage} / {pageCount} · 共 {filteredItems.length} 条</span><button className="icon-button" aria-label="下一页" disabled={currentPage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}><ChevronRight size={18} /></button></div></> : <EmptyState title={statusFilter === 'waiting' ? '当前没有等待处理的验证码或滑块' : statusFilter === 'resolved' ? '当前没有已解决的验证记录' : '当前没有验证记录'} />}
  </div>;
}
