import type { ReactNode } from 'react';
import './panel.css';

export interface PanelProps {
  title?: string | undefined;
  /** Right-aligned header controls. */
  actions?: ReactNode | undefined;
  /** Small text under the title (e.g. "8 sources"). */
  subtitle?: string | undefined;
  children?: ReactNode | undefined;
  className?: string | undefined;
  /** No padding around children (lists/tables that manage their own). */
  flush?: boolean | undefined;
  /** Render as a landmark region (role="region" with aria-label = title). */
  region?: boolean | undefined;
}

export function Panel({ title, actions, subtitle, children, className, flush, region }: PanelProps) {
  const cls = `wv-panel${flush ? ' wv-panel--flush' : ''}${className ? ` ${className}` : ''}`;
  const landmark = region && title ? { role: 'region', 'aria-label': title } : {};
  return (
    <section className={cls} {...landmark}>
      {title || actions ? (
        <header className="wv-panel__header">
          <div className="wv-panel__titles">
            {title ? <h2 className="wv-panel__title">{title}</h2> : null}
            {subtitle ? <span className="wv-panel__subtitle">{subtitle}</span> : null}
          </div>
          {actions ? <div className="wv-panel__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="wv-panel__body">{children}</div>
    </section>
  );
}

export interface FieldListProps {
  /** Label/value rows. Values that are undefined are omitted so the panel never shows "—" for missing data. */
  rows: Array<{ label: string; value: ReactNode | undefined; mono?: boolean | undefined; title?: string | undefined }>;
  className?: string | undefined;
}

/** Key/value description list used by context sections. */
export function FieldList({ rows, className }: FieldListProps) {
  const visible = rows.filter((r) => r.value !== undefined && r.value !== null && r.value !== '');
  if (visible.length === 0) return null;
  return (
    <dl className={`wv-fields${className ? ` ${className}` : ''}`}>
      {visible.map((r) => (
        <div key={r.label} className="wv-fields__row" title={r.title}>
          <dt className="wv-fields__label">{r.label}</dt>
          <dd className={`wv-fields__value${r.mono ? ' wv-mono' : ' wv-num'}`}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface SectionProps {
  title: string;
  children?: ReactNode | undefined;
  actions?: ReactNode | undefined;
}

/** Titled sub-section inside a panel (context sections use this). */
export function Section({ title, children, actions }: SectionProps) {
  return (
    <section className="wv-section" aria-label={title}>
      <header className="wv-section__header">
        <h3 className="wv-section__title wv-caps">{title}</h3>
        {actions ? <div className="wv-section__actions">{actions}</div> : null}
      </header>
      <div className="wv-section__body">{children}</div>
    </section>
  );
}
