import React from 'react';
import { AlertTriangle, CheckCircle2, LoaderCircle, X } from 'lucide-react';
import { labelStatus, runtimeTone } from '../app/format.js';

export function IconButton({ label, children, className = '', ...props }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} {...props}>{children}</button>;
}

export function StatusBadge({ status, label }) {
  return <span className={`status-badge ${runtimeTone(status)}`}><span className="status-dot" />{label || labelStatus(status)}</span>;
}

export function EmptyState({ title = '暂无数据', detail }) {
  return <div className="empty-state"><CheckCircle2 size={28} /><strong>{title}</strong>{detail && <span>{detail}</span>}</div>;
}

export function LoadingBlock({ label = '数据加载中' }) {
  return <div className="loading-block"><LoaderCircle className="spin" size={20} />{label}</div>;
}

export function ErrorBanner({ error, onClose }) {
  if (!error) return null;
  return <div className="error-banner" role="alert"><AlertTriangle size={18} /><span>{String(error.message || error)}</span>{onClose && <IconButton label="关闭" onClick={onClose}><X size={16} /></IconButton>}</div>;
}

export function Modal({ title, children, onClose, width = 520 }) {
  return <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
    <section className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ '--modal-width': `${width}px` }}>
      <header className="modal-header"><h2>{title}</h2>{onClose && <IconButton label="关闭" onClick={onClose}><X size={18} /></IconButton>}</header>
      <div className="modal-body">{children}</div>
    </section>
  </div>;
}

export function DataPairs({ value, empty = '暂无数据' }) {
  if (!value || typeof value !== 'object' || !Object.keys(value).length) return <EmptyState title={empty} />;
  return <dl className="data-pairs">{Object.entries(value).filter(([, item]) => item == null || ['string', 'number', 'boolean'].includes(typeof item)).map(([key, item]) => <React.Fragment key={key}><dt>{key}</dt><dd>{typeof item === 'boolean' ? item ? '是' : '否' : String(item ?? '-')}</dd></React.Fragment>)}</dl>;
}
